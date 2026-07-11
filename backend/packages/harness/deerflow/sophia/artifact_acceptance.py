from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from deerflow.sophia.build_manifest import utc_now_iso


class ArtifactAcceptedPayload(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    build_id: str
    logical_artifact_id: str
    artifact_version_id: str
    manifest_revision: int
    artifact_type: str
    artifact_path: str
    storage_object_path: str
    project_id: str | None = None
    origin: str
    accepted_at: str = Field(default_factory=utc_now_iso)

    @property
    def idempotency_key(self) -> str:
        return f"{self.logical_artifact_id}:{self.artifact_version_id}:{self.manifest_revision}"


class ArtifactAcceptanceOutbox(Protocol):
    def enqueue(self, payload: ArtifactAcceptedPayload) -> bool: ...


class InMemoryArtifactAcceptanceOutbox:
    def __init__(self) -> None:
        self._pending: dict[str, ArtifactAcceptedPayload] = {}

    def enqueue(self, payload: ArtifactAcceptedPayload) -> bool:
        if payload.idempotency_key in self._pending:
            return False
        self._pending[payload.idempotency_key] = payload
        return True

    def pending(self) -> list[ArtifactAcceptedPayload]:
        return list(self._pending.values())
