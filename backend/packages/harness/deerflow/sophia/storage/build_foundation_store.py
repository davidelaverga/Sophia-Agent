from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any

import httpx

from deerflow.sophia.artifact_acceptance import ArtifactAcceptedPayload
from deerflow.sophia.build_manifest import BuildManifest
from deerflow.sophia.build_runtime.events import BuildOperationEvent

logger = logging.getLogger(__name__)


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
        self._availability = "unknown"
        self._availability_lock = threading.Lock()
        self._unavailable_logged = False

    @property
    def availability_status(self) -> str:
        return self._availability

    def probe(self) -> bool:
        """Verify the event table and required RPCs through PostgREST OpenAPI."""

        if self._availability == "unavailable":
            return False
        try:
            response = self._client.get(
                f"{self._config.url}/rest/v1/",
                headers={**self._headers(), "Accept": "application/openapi+json"},
            )
            response.raise_for_status()
            document = response.json()
            paths = set((document.get("paths") or {}).keys()) if isinstance(document, dict) else set()
            required = {
                "/sophia_build_operation_events",
                "/rpc/sophia_append_build_event",
                "/rpc/sophia_commit_build_manifest",
            }
            if not required.issubset(paths):
                missing = ",".join(sorted(required - paths))
                self._mark_unavailable(f"missing_schema_paths:{missing}")
                return False
        except (httpx.HTTPError, ValueError) as exc:
            self._mark_unavailable(type(exc).__name__)
            return False
        with self._availability_lock:
            self._availability = "available"
        return True

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Content-Type": "application/json",
        }

    def _rpc(self, name: str, payload: dict[str, Any]) -> Any:
        if self._availability == "unavailable":
            raise BuildFoundationStoreError("build foundation store is unavailable")
        try:
            response = self._client.post(
                f"{self._config.url}/rest/v1/rpc/{name}",
                headers=self._headers(),
                json=payload,
            )
            response.raise_for_status()
            self._mark_available()
            return response.json() if response.text else None
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                self._mark_unavailable(f"rpc_404:{name}")
            raise BuildFoundationStoreError(f"build foundation RPC failed: {name}") from exc

    def _mark_unavailable(self, reason: str) -> None:
        with self._availability_lock:
            self._availability = "unavailable"
            should_log = not self._unavailable_logged
            self._unavailable_logged = True
        if should_log:
            logger.error(
                "Build foundation event store unavailable; persistence circuit opened reason=%s payloadExcluded=true",
                reason,
            )

    def _mark_available(self) -> None:
        with self._availability_lock:
            if self._availability != "unavailable":
                self._availability = "available"

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
        if self._availability == "unavailable":
            raise BuildFoundationStoreError("build foundation store is unavailable")
        try:
            response = self._client.get(
                f"{self._config.url}/rest/v1/sophia_build_operation_events",
                headers=self._headers(),
                params={"select": "event_payload", "build_id": f"eq.{build_id}", "order": "sequence.asc"},
            )
            response.raise_for_status()
            rows = response.json()
            self._mark_available()
            return [BuildOperationEvent.model_validate(row["event_payload"]) for row in rows]
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                self._mark_unavailable("event_table_404")
            raise BuildFoundationStoreError("build foundation event replay failed") from exc


def configured_build_foundation_store() -> SupabaseBuildFoundationStore | None:
    config = BuildFoundationStoreConfig.from_env()
    return SupabaseBuildFoundationStore(config) if config else None
