from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import httpx

from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import BuildManifest
from deerflow.sophia.build_runtime.events import BuildOperationEvent


class BuildFoundationStoreError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class BuildFoundationStoreConfig:
    url: str
    service_role_key: str

    @classmethod
    def from_env(cls) -> BuildFoundationStoreConfig | None:
        url = (os.getenv("SUPABASE_URL") or "").strip().rstrip("/")
        key = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        return cls(url, key) if url and key else None


class SupabaseBuildFoundationStore:
    def __init__(self, config: BuildFoundationStoreConfig, *, client: httpx.Client | None = None) -> None:
        self._config = config
        self._client = client or httpx.Client(timeout=15.0)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Content-Type": "application/json",
        }

    def _rpc(self, name: str, payload: dict[str, Any]) -> Any:
        try:
            response = self._client.post(
                f"{self._config.url}/rest/v1/rpc/{name}",
                headers=self._headers(),
                json=payload,
            )
            response.raise_for_status()
            return response.json() if response.text else None
        except (httpx.HTTPError, ValueError) as exc:
            raise BuildFoundationStoreError(f"build foundation RPC failed: {name}") from exc

    def commit_manifest(
        self,
        *,
        manifest: BuildManifest,
        manifest_path: str,
        manifest_hash: str,
        acceptance: ArtifactAcceptedPayload | None = None,
    ) -> int:
        result = self._rpc(
            "sophia_commit_build_manifest",
            {
                "p_build_id": manifest.build_id,
                "p_user_id": manifest.user_id,
                "p_owner_thread_id": manifest.thread_id,
                "p_expected_revision": max(0, manifest.manifest_revision - 1),
                "p_manifest_object_path": manifest_path,
                "p_manifest_hash": manifest_hash,
                "p_logical_artifact_id": manifest.logical_artifact_id,
                "p_artifact_version_id": manifest.current_artifact_version_id,
                "p_status": manifest.status,
                "p_format": manifest.format,
                "p_project_id": None,
                "p_acceptance_payload": acceptance.model_dump(mode="json") if acceptance else None,
            },
        )
        return int(result)

    def append(self, event: BuildOperationEvent) -> None:
        self._rpc(
            "sophia_append_build_event",
            {
                "p_build_id": event.build_id,
                "p_event_id": event.event_id,
                "p_user_id": event.user_id,
                "p_event_type": event.event_type,
                "p_occurred_at": event.occurred_at,
                "p_event_payload": event.model_dump(mode="json", exclude_none=True),
            },
        )

    def replay(self, *, build_id: str) -> list[BuildOperationEvent]:
        response = self._client.get(
            f"{self._config.url}/rest/v1/sophia_build_operation_events",
            headers=self._headers(),
            params={"select": "event_payload", "build_id": f"eq.{build_id}", "order": "sequence.asc"},
        )
        response.raise_for_status()
        rows = response.json()
        return [BuildOperationEvent.model_validate(row["event_payload"]) for row in rows]


def configured_build_foundation_store() -> SupabaseBuildFoundationStore | None:
    config = BuildFoundationStoreConfig.from_env()
    return SupabaseBuildFoundationStore(config) if config else None
