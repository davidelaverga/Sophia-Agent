from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import (
    BuildManifest,
    BuildManifestConcurrentModification,
)
from deerflow.sophia.build_mutation import BuildMutationTransaction
from deerflow.sophia.storage.supabase_artifact_store import (
    normalize_object_path,
    safe_object_path_segment,
)

_REQUIRED_RPC_PATHS = frozenset(
    {
        "/rpc/sophia_create_build_mutation_transaction",
        "/rpc/sophia_get_build_mutation_transaction",
        "/rpc/sophia_acquire_build_mutation_lease",
        "/rpc/sophia_transition_build_mutation_transaction",
        "/rpc/sophia_recover_build_mutation_transactions",
        "/rpc/sophia_get_build_manifest_head",
        "/rpc/sophia_commit_build_mutation_manifest",
    }
)
_STATUSES = frozenset(
    {
        "prepared",
        "staged",
        "verified",
        "committing",
        "committed",
        "rolling_back",
        "rolled_back",
        "failed",
    }
)
_MANIFEST_CONFLICT_CODES = frozenset(
    {
        "build_manifest_concurrent_modification",
        "build_registry_concurrent_modification",
    }
)
_STALE_LEASE_CODES = frozenset(
    {
        "build_mutation_stale_commit_lease",
        "build_mutation_stale_lease",
    }
)


class BuildMutationPersistenceError(RuntimeError):
    """Fail-closed durable mutation boundary error without response data."""


class BuildMutationPersistenceConfigurationError(BuildMutationPersistenceError):
    pass


class BuildMutationPersistenceScopeError(BuildMutationPersistenceError):
    pass


class BuildMutationPersistenceProtocolError(BuildMutationPersistenceError):
    pass


class BuildMutationPersistenceStaleLeaseError(BuildMutationPersistenceError):
    pass


class BuildMutationPersistenceRpcError(BuildMutationPersistenceError):
    def __init__(self, operation: str, *, status_code: int | None = None) -> None:
        suffix = f" status={status_code}" if status_code is not None else ""
        super().__init__(f"build mutation persistence RPC failed operation={operation}{suffix}")
        self.operation = operation
        self.status_code = status_code


@dataclass(frozen=True, slots=True)
class BuildMutationStoreConfig:
    url: str
    service_role_key: str = field(repr=False)
    canary_user_ids: frozenset[str]

    def __post_init__(self) -> None:
        url = self.url.strip().rstrip("/")
        key = self.service_role_key.strip()
        raw_users = self.canary_user_ids
        if isinstance(raw_users, str):
            raise BuildMutationPersistenceConfigurationError("mutation canary user IDs must be an exact set")
        users = frozenset(raw_users)
        if not url or not key:
            raise BuildMutationPersistenceConfigurationError("Supabase mutation persistence credentials are incomplete")
        if not users:
            raise BuildMutationPersistenceConfigurationError("mutation persistence requires an exact canary user set")
        if any(not isinstance(user_id, str) or not user_id or safe_object_path_segment(user_id, default="user") != user_id for user_id in users):
            raise BuildMutationPersistenceConfigurationError("mutation canary user IDs must be canonical durable-path segments")
        object.__setattr__(self, "url", url)
        object.__setattr__(self, "service_role_key", key)
        object.__setattr__(self, "canary_user_ids", users)

    @classmethod
    def from_env(
        cls,
        *,
        canary_user_ids: frozenset[str],
    ) -> BuildMutationStoreConfig | None:
        url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
        key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        if not url or not key:
            return None
        return cls(
            url=url,
            service_role_key=key,
            canary_user_ids=canary_user_ids,
        )


def _aware_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("timestamp is absent")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp is not timezone-aware")
    return parsed


def _validated_transaction(transaction: BuildMutationTransaction) -> BuildMutationTransaction:
    try:
        return BuildMutationTransaction.model_validate(transaction.model_dump(mode="json"))
    except (TypeError, ValidationError, ValueError):
        raise BuildMutationPersistenceProtocolError("build mutation transaction failed validation") from None


def _canonical_segment(value: str, *, label: str) -> str:
    if not value or safe_object_path_segment(value, default=label) != value:
        raise BuildMutationPersistenceProtocolError("build mutation durable object identity is not canonical")
    return value


def expected_mutation_manifest_object_path(manifest: BuildManifest) -> str:
    user_id = _canonical_segment(manifest.user_id, label="user")
    thread_id = _canonical_segment(manifest.thread_id, label="thread")
    build_id = _canonical_segment(manifest.build_id, label="build")
    return normalize_object_path(f"artifacts/{user_id}/{thread_id}/foundation/.builder/builds/{build_id}/manifest/manifest-r{manifest.manifest_revision}.json")


def _require_dq2_evidence(
    transaction: BuildMutationTransaction,
    *,
    comparison_required: bool = False,
) -> None:
    selectors = transaction.authorized_selectors
    source_roles = transaction.authorized_source_roles
    component_versions = transaction.expected_component_versions
    missing = (
        transaction.campaign_run_id is None
        or transaction.owner_thread_id is None
        or safe_object_path_segment(transaction.owner_thread_id, default="thread") != transaction.owner_thread_id
        or not selectors
        or not source_roles
        or transaction.repair_program_hash is None
        or transaction.initial_quality_run_id is None
        or transaction.expected_artifact_version_id is None
        or not transaction.expected_artifact_version_id.strip()
        or transaction.expected_artifact_hash is None
        or re.fullmatch(r"[0-9a-f]{64}", transaction.expected_artifact_hash) is None
        or not component_versions
    )
    comparison_missing = comparison_required and (transaction.candidate_quality_run_id is None or transaction.comparison_hash is None)
    comparison_invalid = (transaction.candidate_quality_run_id is None) != (transaction.comparison_hash is None) or (
        transaction.candidate_quality_run_id is not None and transaction.candidate_quality_run_id == transaction.initial_quality_run_id
    )
    invalid_roles = (
        len(selectors) != len(set(selectors))
        or any(not selector.strip() or len(selector) > 512 for selector in selectors)
        or set(source_roles) != set(selectors)
        or not set(selectors).issubset(component_versions)
        or any(not roles or len(roles) != len(set(roles)) or any(not role.strip() or len(role) > 256 for role in roles) for roles in source_roles.values())
    )
    invalid_components = any(not component.strip() or len(component) > 512 or not version.strip() or len(version) > 512 for component, version in component_versions.items())
    if missing or comparison_missing or comparison_invalid or invalid_roles or invalid_components:
        raise BuildMutationPersistenceProtocolError("DQ-2 mutation evidence identity is incomplete")


class BuildMutationManifestHead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    build_id: str
    user_id: str
    owner_thread_id: str
    manifest_revision: int = Field(ge=1)
    manifest_object_path: str
    manifest_hash: str
    logical_artifact_id: str | None = None
    current_artifact_version_id: str | None = None
    status: str
    format: str
    updated_at: str


class SupabaseBuildMutationStore:
    """Service-role-only durable store for exact-canary DQ-2 mutations."""

    def __init__(
        self,
        config: BuildMutationStoreConfig,
        *,
        client: httpx.Client | None = None,
    ) -> None:
        self._config = config
        self._client = client or httpx.Client(timeout=15.0)
        self._owns_client = client is None

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Content-Type": "application/json",
        }

    def _require_canary(self, user_id: str) -> None:
        if user_id not in self._config.canary_user_ids:
            raise BuildMutationPersistenceScopeError("build mutation user is outside the exact canary scope")

    @staticmethod
    def _require_lease_request(*, lease_owner: str, lease_seconds: int) -> None:
        if not lease_owner or len(lease_owner) > 256:
            raise BuildMutationPersistenceProtocolError("build mutation lease owner is invalid")
        if isinstance(lease_seconds, bool) or not isinstance(lease_seconds, int) or not 1 <= lease_seconds <= 900:
            raise BuildMutationPersistenceProtocolError("build mutation lease duration is invalid")

    def _rpc(self, operation: str, payload: Mapping[str, object]) -> object:
        try:
            response = self._client.post(
                f"{self._config.url}/rest/v1/rpc/{operation}",
                headers=self._headers(),
                json=dict(payload),
            )
        except httpx.HTTPError:
            raise BuildMutationPersistenceRpcError(operation) from None
        if response.status_code >= 400:
            safe_error_code: str | None = None
            try:
                error_payload = response.json()
                if isinstance(error_payload, dict):
                    candidate = error_payload.get("message")
                    if isinstance(candidate, str):
                        safe_error_code = candidate.strip()
            except ValueError:
                pass
            if operation == "sophia_commit_build_mutation_manifest":
                if safe_error_code in _MANIFEST_CONFLICT_CODES:
                    raise BuildManifestConcurrentModification("build_manifest_concurrent_modification") from None
                if safe_error_code in _STALE_LEASE_CODES:
                    raise BuildMutationPersistenceStaleLeaseError("build mutation atomic commit lease is stale") from None
            raise BuildMutationPersistenceRpcError(operation, status_code=response.status_code) from None
        if not response.content:
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence RPC returned no record operation={operation}")
        try:
            return response.json()
        except ValueError:
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence RPC returned invalid JSON operation={operation}") from None

    @staticmethod
    def _record(operation: str, value: object) -> BuildMutationTransaction:
        if not isinstance(value, dict):
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence record invalid operation={operation}")
        payload = value.get("transaction_payload")
        if not isinstance(payload, dict):
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence payload invalid operation={operation}")
        try:
            transaction = BuildMutationTransaction.model_validate(payload)
            row_revision = value["expected_manifest_revision"]
            if isinstance(row_revision, bool) or not isinstance(row_revision, int):
                raise ValueError("revision type mismatch")
            if (
                value["transaction_id"] != transaction.transaction_id
                or value["build_id"] != transaction.build_id
                or value["user_id"] != transaction.user_id
                or value["operation_id"] != transaction.operation_id
                or row_revision != transaction.expected_manifest_revision
                or value["status"] != transaction.status
                or value["lease_owner"] != transaction.lease_owner
                or _aware_timestamp(value["lease_expires_at"]) != _aware_timestamp(transaction.lease_expires_at)
            ):
                raise ValueError("row and payload mismatch")
        except (KeyError, TypeError, ValidationError, ValueError):
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence record failed validation operation={operation}") from None
        return transaction

    @classmethod
    def _records(
        cls,
        operation: str,
        value: object,
        *,
        maximum: int,
    ) -> list[BuildMutationTransaction]:
        if not isinstance(value, list) or len(value) > maximum:
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence response shape invalid operation={operation}")
        return [cls._record(operation, item) for item in value]

    def _one(self, operation: str, value: object) -> BuildMutationTransaction:
        records = self._records(operation, value, maximum=1)
        if len(records) != 1:
            raise BuildMutationPersistenceProtocolError(f"build mutation persistence response cardinality invalid operation={operation}")
        return records[0]

    def probe(self) -> None:
        try:
            response = self._client.get(
                f"{self._config.url}/rest/v1/",
                headers={**self._headers(), "Accept": "application/openapi+json"},
            )
        except httpx.HTTPError:
            raise BuildMutationPersistenceRpcError("probe") from None
        if response.status_code >= 400:
            raise BuildMutationPersistenceRpcError("probe", status_code=response.status_code) from None
        try:
            document = response.json()
            paths = set(document["paths"])
        except (KeyError, TypeError, ValueError):
            raise BuildMutationPersistenceProtocolError("build mutation persistence OpenAPI probe was invalid") from None
        if not _REQUIRED_RPC_PATHS.issubset(paths):
            raise BuildMutationPersistenceProtocolError("build mutation persistence OpenAPI probe is missing required RPCs")

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def create(self, transaction: BuildMutationTransaction) -> BuildMutationTransaction:
        self._require_canary(transaction.user_id)
        transaction = _validated_transaction(transaction)
        _require_dq2_evidence(transaction)
        if transaction.status != "prepared":
            raise BuildMutationPersistenceProtocolError("new build mutation transaction must be prepared")
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
            raise BuildMutationPersistenceProtocolError("new build mutation transaction contains premature candidate identity")
        operation = "sophia_create_build_mutation_transaction"
        result = self._rpc(
            operation,
            {
                "p_user_id": transaction.user_id,
                "p_transaction_payload": transaction.model_dump(mode="json"),
            },
        )
        created = self._one(operation, result)
        if (
            created.user_id != transaction.user_id
            or created.build_id != transaction.build_id
            or created.operation_id != transaction.operation_id
            or created.owner_thread_id != transaction.owner_thread_id
            or created.expected_manifest_revision != transaction.expected_manifest_revision
            or created.campaign_run_id != transaction.campaign_run_id
            or created.authorized_selectors != transaction.authorized_selectors
            or created.authorized_source_roles != transaction.authorized_source_roles
            or created.repair_program_hash != transaction.repair_program_hash
            or created.initial_quality_run_id != transaction.initial_quality_run_id
            or created.expected_artifact_version_id != transaction.expected_artifact_version_id
            or created.expected_artifact_hash != transaction.expected_artifact_hash
            or created.expected_component_versions != transaction.expected_component_versions
        ):
            raise BuildMutationPersistenceProtocolError("build mutation create response escaped the operation scope")
        return created

    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction:
        self._require_canary(user_id)
        operation = "sophia_get_build_mutation_transaction"
        result = self._rpc(
            operation,
            {"p_transaction_id": transaction_id, "p_user_id": user_id},
        )
        loaded = self._one(operation, result)
        if loaded.transaction_id != transaction_id or loaded.user_id != user_id:
            raise BuildMutationPersistenceProtocolError("build mutation load response escaped the transaction scope")
        return loaded

    def load_manifest_head(self, *, build_id: str, user_id: str) -> BuildMutationManifestHead:
        self._require_canary(user_id)
        operation = "sophia_get_build_manifest_head"
        result = self._rpc(
            operation,
            {"p_build_id": build_id, "p_user_id": user_id},
        )
        if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
            raise BuildMutationPersistenceProtocolError("build mutation manifest head response cardinality invalid")
        try:
            head = BuildMutationManifestHead.model_validate(result[0])
            _aware_timestamp(head.updated_at)
        except (TypeError, ValidationError, ValueError):
            raise BuildMutationPersistenceProtocolError("build mutation manifest head failed validation") from None
        if head.user_id != user_id or head.build_id != build_id:
            raise BuildMutationPersistenceProtocolError("build mutation manifest head escaped the build scope")
        return head

    def commit_manifest(
        self,
        transaction: BuildMutationTransaction,
        *,
        manifest: BuildManifest,
        manifest_object_path: str,
        manifest_hash: str,
        acceptance: ArtifactAcceptedPayload,
    ) -> BuildMutationTransaction:
        self._require_canary(transaction.user_id)
        transaction = _validated_transaction(transaction)
        _require_dq2_evidence(transaction, comparison_required=True)
        artifact_version_id = manifest.current_artifact_version_id
        logical_artifact_id = manifest.logical_artifact_id
        deck_extension = manifest.format_extensions.get("deck")
        manifest_artifact_hash = deck_extension.get("current_pptx_hash") if isinstance(deck_extension, dict) else None
        new_revision = transaction.expected_manifest_revision + 1
        expected_manifest_path = expected_mutation_manifest_object_path(manifest)
        if artifact_version_id is not None:
            _canonical_segment(artifact_version_id, label="artifact_version")
        expected_artifact_prefix = normalize_object_path(f"artifacts/{manifest.user_id}/{manifest.thread_id}/foundation/.builder/builds/{manifest.build_id}/artifacts/{artifact_version_id}") + "/"
        try:
            normalized_acceptance_path = normalize_object_path(acceptance.storage_object_path)
        except ValueError:
            normalized_acceptance_path = ""
        invalid = (
            transaction.status != "committing"
            or manifest.user_id != transaction.user_id
            or manifest.build_id != transaction.build_id
            or manifest.thread_id != transaction.owner_thread_id
            or manifest.manifest_revision != new_revision
            or logical_artifact_id is None
            or artifact_version_id is None
            or artifact_version_id not in transaction.candidate_version_ids
            or artifact_version_id == transaction.expected_artifact_version_id
            or artifact_version_id != transaction.candidate_artifact_version_id
            or manifest_artifact_hash != transaction.candidate_artifact_hash
            or manifest_object_path != expected_manifest_path
            or manifest_object_path != transaction.candidate_manifest_object_path
            or re.fullmatch(r"[0-9a-f]{64}", manifest_hash) is None
            or manifest_hash != transaction.candidate_manifest_hash
            or acceptance.build_id != manifest.build_id
            or acceptance.logical_artifact_id != logical_artifact_id
            or acceptance.artifact_version_id != artifact_version_id
            or acceptance.manifest_revision != new_revision
            or acceptance.artifact_type != manifest.format
            or acceptance.origin != "quality_repair"
            or normalized_acceptance_path != acceptance.storage_object_path
            or not normalized_acceptance_path.startswith(expected_artifact_prefix)
        )
        if invalid:
            raise BuildMutationPersistenceProtocolError("build mutation manifest commit identity is invalid")
        operation = "sophia_commit_build_mutation_manifest"
        result = self._rpc(
            operation,
            {
                "p_transaction_id": transaction.transaction_id,
                "p_user_id": transaction.user_id,
                "p_lease_owner": transaction.lease_owner,
                "p_lease_expires_at": transaction.lease_expires_at,
                "p_owner_thread_id": manifest.thread_id,
                "p_manifest_object_path": manifest_object_path,
                "p_manifest_hash": manifest_hash,
                "p_logical_artifact_id": logical_artifact_id,
                "p_artifact_version_id": artifact_version_id,
                "p_status": manifest.status,
                "p_format": manifest.format,
                "p_project_id": acceptance.project_id,
                "p_acceptance_payload": acceptance.model_dump(mode="json"),
            },
        )
        committed = self._one(operation, result)
        expected = transaction.model_copy(update={"status": "committed", "committed_manifest_revision": new_revision})
        if committed != expected:
            raise BuildMutationPersistenceProtocolError("build mutation manifest commit response escaped the atomic CAS scope")
        return committed

    def acquire_lease(
        self,
        *,
        transaction_id: str,
        user_id: str,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> BuildMutationTransaction:
        self._require_canary(user_id)
        self._require_lease_request(lease_owner=lease_owner, lease_seconds=lease_seconds)
        operation = "sophia_acquire_build_mutation_lease"
        result = self._rpc(
            operation,
            {
                "p_transaction_id": transaction_id,
                "p_user_id": user_id,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
            },
        )
        leased = self._one(operation, result)
        if leased.transaction_id != transaction_id or leased.user_id != user_id or leased.lease_owner != lease_owner:
            raise BuildMutationPersistenceProtocolError("build mutation lease response escaped the transaction scope")
        return leased

    def transition(
        self,
        transaction: BuildMutationTransaction,
        *,
        expected_status: str,
    ) -> BuildMutationTransaction:
        self._require_canary(transaction.user_id)
        transaction = _validated_transaction(transaction)
        if transaction.status == "committed":
            raise BuildMutationPersistenceProtocolError("committed DQ-2 mutations require the atomic manifest commit RPC")
        _require_dq2_evidence(
            transaction,
            comparison_required=transaction.status in {"verified", "committing", "committed"},
        )
        if expected_status not in _STATUSES:
            raise BuildMutationPersistenceProtocolError("expected build mutation status is invalid")
        operation = "sophia_transition_build_mutation_transaction"
        result = self._rpc(
            operation,
            {
                "p_transaction_id": transaction.transaction_id,
                "p_user_id": transaction.user_id,
                "p_lease_owner": transaction.lease_owner,
                "p_expected_status": expected_status,
                "p_new_status": transaction.status,
                "p_transaction_payload": transaction.model_dump(mode="json"),
            },
        )
        transitioned = self._one(operation, result)
        if transitioned != transaction:
            raise BuildMutationPersistenceProtocolError("build mutation transition response escaped the status CAS scope")
        return transitioned

    def recover_incomplete(
        self,
        *,
        build_id: str,
        user_id: str,
        lease_owner: str | None = None,
        lease_seconds: int = 120,
        limit: int = 50,
    ) -> list[BuildMutationTransaction]:
        self._require_canary(user_id)
        if lease_owner is None:
            raise BuildMutationPersistenceProtocolError("build mutation recovery requires a new lease owner")
        self._require_lease_request(lease_owner=lease_owner, lease_seconds=lease_seconds)
        if isinstance(limit, bool) or not 1 <= limit <= 100:
            raise BuildMutationPersistenceProtocolError("build mutation recovery limit is invalid")
        operation = "sophia_recover_build_mutation_transactions"
        result = self._rpc(
            operation,
            {
                "p_build_id": build_id,
                "p_user_id": user_id,
                "p_lease_owner": lease_owner,
                "p_lease_seconds": lease_seconds,
                "p_limit": limit,
            },
        )
        recovered = self._records(operation, result, maximum=limit)
        if any(transaction.user_id != user_id or transaction.build_id != build_id or transaction.lease_owner != lease_owner for transaction in recovered):
            raise BuildMutationPersistenceProtocolError("build mutation recovery response escaped the build scope")
        return recovered


def configured_build_mutation_store(
    *,
    canary_user_ids: frozenset[str],
) -> SupabaseBuildMutationStore | None:
    config = BuildMutationStoreConfig.from_env(canary_user_ids=canary_user_ids)
    return SupabaseBuildMutationStore(config) if config else None
