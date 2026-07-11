from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from deerflow.sophia.build_runtime.identity import new_transaction_id


class BuildMutationTransaction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["sophia-build-transaction/v1"] = "sophia-build-transaction/v1"
    transaction_id: str = Field(default_factory=new_transaction_id)
    build_id: str
    user_id: str
    operation_id: str
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
    expected_artifact_version_id: str | None = None
    expected_artifact_hash: str | None = None
    expected_component_versions: dict[str, str] = Field(default_factory=dict)
    authorized_selectors: list[str] = Field(default_factory=list)
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
    ) -> BuildMutationTransaction:
        expires = datetime.now(UTC) + timedelta(seconds=lease_seconds)
        return cls(
            build_id=build_id,
            user_id=user_id,
            operation_id=operation_id,
            expected_manifest_revision=expected_manifest_revision,
            lease_owner=lease_owner,
            lease_expires_at=expires.isoformat(),
        )


class BuildMutationStore(Protocol):
    def create(self, transaction: BuildMutationTransaction) -> BuildMutationTransaction: ...
    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction: ...
    def transition(self, transaction: BuildMutationTransaction, *, expected_status: str) -> BuildMutationTransaction: ...
    def recover_incomplete(self, *, build_id: str, user_id: str) -> list[BuildMutationTransaction]: ...


class InMemoryBuildMutationStore:
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], BuildMutationTransaction] = {}

    def create(self, transaction: BuildMutationTransaction) -> BuildMutationTransaction:
        key = (transaction.user_id, transaction.transaction_id)
        if key in self._items:
            raise ValueError("transaction already exists")
        self._items[key] = transaction.model_copy(deep=True)
        return transaction.model_copy(deep=True)

    def load(self, *, transaction_id: str, user_id: str) -> BuildMutationTransaction:
        return self._items[(user_id, transaction_id)].model_copy(deep=True)

    def transition(self, transaction: BuildMutationTransaction, *, expected_status: str) -> BuildMutationTransaction:
        key = (transaction.user_id, transaction.transaction_id)
        current = self._items.get(key)
        if current is None or current.status != expected_status:
            raise ValueError("build_mutation_stale_transition")
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
    ) -> BuildMutationTransaction:
        staged = transaction.model_copy(
            update={
                "status": "staged",
                "staged_object_paths": list(object_paths),
                "candidate_version_ids": list(candidate_version_ids),
            }
        )
        return self.transition(staged, expected_status="prepared")

    def mark_verified(self, transaction: BuildMutationTransaction, *, gate_evidence: dict[str, Any]) -> BuildMutationTransaction:
        verified = transaction.model_copy(update={"status": "verified", "gate_evidence": dict(gate_evidence)})
        return self.transition(verified, expected_status="staged")

    def commit(self, transaction: BuildMutationTransaction, *, manifest_revision: int) -> BuildMutationTransaction:
        committed = transaction.model_copy(
            update={"status": "committed", "committed_manifest_revision": manifest_revision}
        )
        return self.transition(committed, expected_status="verified")

    def rollback(
        self,
        transaction: BuildMutationTransaction,
        *,
        failure_code: str,
        recovery_action: str,
    ) -> BuildMutationTransaction:
        rolled_back = transaction.model_copy(
            update={
                "status": "rolled_back",
                "failure_code": failure_code,
                "recovery_action": recovery_action,
            }
        )
        return self.transition(rolled_back, expected_status=transaction.status)

    def recover_incomplete(self, *, build_id: str, user_id: str) -> list[BuildMutationTransaction]:
        terminal = {"committed", "rolled_back", "failed"}
        return [
            transaction.model_copy(deep=True)
            for (owner, _), transaction in self._items.items()
            if owner == user_id and transaction.build_id == build_id and transaction.status not in terminal
        ]
