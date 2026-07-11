from __future__ import annotations

from typing import Protocol

from pydantic import BaseModel, ConfigDict

from deerflow.sophia.build_manifest import utc_now_iso


class BuildRegistryRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    build_id: str
    user_id: str
    owner_thread_id: str
    logical_artifact_id: str | None = None
    current_artifact_version_id: str | None = None
    manifest_object_path: str
    current_manifest_revision: int
    status: str
    format: str
    project_id: str | None = None
    updated_at: str = ""
    registry_sync_pending: bool = False

    def model_post_init(self, __context: object) -> None:
        if not self.updated_at:
            self.updated_at = utc_now_iso()


class BuildRegistry(Protocol):
    def register_fresh(self, record: BuildRegistryRecord) -> BuildRegistryRecord: ...
    def resolve_for_user(self, *, build_id: str, user_id: str) -> BuildRegistryRecord: ...
    def project(self, record: BuildRegistryRecord, *, expected_revision: int) -> BuildRegistryRecord: ...


class InMemoryBuildRegistry:
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], BuildRegistryRecord] = {}

    def register_fresh(self, record: BuildRegistryRecord) -> BuildRegistryRecord:
        key = (record.user_id, record.build_id)
        if key in self._records:
            raise ValueError("build registry record already exists")
        self._records[key] = record.model_copy(deep=True)
        return record.model_copy(deep=True)

    def resolve_for_user(self, *, build_id: str, user_id: str) -> BuildRegistryRecord:
        return self._records[(user_id, build_id)].model_copy(deep=True)

    def project(self, record: BuildRegistryRecord, *, expected_revision: int) -> BuildRegistryRecord:
        key = (record.user_id, record.build_id)
        current = self._records.get(key)
        if current is None or current.current_manifest_revision != expected_revision:
            raise ValueError("build_registry_projection_stale")
        self._records[key] = record.model_copy(deep=True)
        return record.model_copy(deep=True)
