"""The only production module allowed to call Mem0.

Provider content is never returned to callers.  The adapter exposes IDs,
scores, metadata verification, and normalized result classes only.
"""

from __future__ import annotations

import importlib.metadata
import os
import threading
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Literal

from .models import ProviderHit

PINNED_MEM0AI_VERSION = "1.0.9"
PINNED_MEM0_HOST = "https://api.mem0.ai"
PINNED_SEARCH_PATH = "/v2/memories/search/"
PINNED_CRUD_PATH = "/v1/memories/"


class Mem0ContractError(RuntimeError):
    def __init__(
        self,
        reason: str,
        *,
        retryable: bool = False,
        ambiguous_effect: bool = False,
        provider_ids: tuple[str, ...] = (),
    ) -> None:
        self.reason = reason
        self.retryable = retryable
        self.ambiguous_effect = ambiguous_effect
        self.provider_ids = provider_ids
        super().__init__(reason)


@dataclass(frozen=True)
class ProviderMutationResult:
    status: Literal["created", "deleted", "missing", "verified", "ambiguous"]
    provider_ids: tuple[str, ...] = ()
    metadata_verified: bool = False


class LegacyMem0Facade:
    """Compatibility boundary for flags-off callers during additive rollout.

    The rest of Sophia can retain its legacy response handling temporarily,
    but no production module receives or constructs the provider SDK client.
    """

    def __init__(self) -> None:
        self._adapter = Mem0ProjectionAdapter()

    def ensure_client(self) -> None:
        self._adapter._get_client()

    def search(self, **kwargs: object) -> object:
        return self._adapter._get_client().search(**kwargs)

    def add(self, **kwargs: object) -> object:
        return self._adapter._get_client().add(**kwargs)

    def get_all(self, **kwargs: object) -> object:
        return self._adapter._get_client().get_all(**kwargs)

    def get(self, memory_id: str) -> object:
        return self._adapter._get_client().get(memory_id)

    def delete(self, memory_id: str | None = None, **kwargs: object) -> object:
        target = memory_id or str(kwargs.get("memory_id") or "")
        if not target:
            raise Mem0ContractError("mem0_delete_id_missing")
        return self._adapter._get_client().delete(target)

    def update(self, memory_id: str, **kwargs: object) -> object:
        return self._adapter._get_client().update(memory_id, **kwargs)

    def update_metadata(self, *, memory_id: str, metadata: dict[str, object]) -> dict[str, Any]:
        raw_client = self._adapter._get_client()
        params = {}
        if getattr(raw_client, "org_id", None):
            params["org_id"] = raw_client.org_id
        if getattr(raw_client, "project_id", None):
            params["project_id"] = raw_client.project_id
        response = raw_client.client.put(
            f"/v1/memories/{memory_id}/",
            json={"metadata": metadata},
            params=params or None,
        )
        response.raise_for_status()
        result = response.json()
        return result if isinstance(result, dict) else {}


def legacy_search_via_rest(
    *,
    httpx_module: Any,
    api_key: str,
    host: str,
    user_id: str,
    query: str,
    limit: int,
) -> dict[str, Any]:
    """Flags-off REST fallback, kept inside the sole provider boundary."""

    with httpx_module.Client(
        base_url=host,
        headers={"Authorization": f"Token {api_key}"},
        timeout=30.0,
    ) as client:
        response = client.post(
            PINNED_SEARCH_PATH,
            json={"query": query, "filters": {"user_id": user_id}, "limit": limit},
        )
        response.raise_for_status()
        result = response.json()
    if isinstance(result, list):
        return {"results": result}
    return result if isinstance(result, dict) else {"results": []}


class Mem0ProjectionAdapter:
    def __init__(self, *, client: Any | None = None) -> None:
        installed = importlib.metadata.version("mem0ai")
        if installed != PINNED_MEM0AI_VERSION:
            raise Mem0ContractError("mem0_sdk_version_mismatch")
        configured_host = (os.getenv("MEM0_BASE_URL") or PINNED_MEM0_HOST).rstrip("/")
        if configured_host != PINNED_MEM0_HOST:
            raise Mem0ContractError("mem0_endpoint_contract_mismatch")
        self._client = client
        self._lock = threading.Lock()

    def _get_client(self) -> Any:
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is not None:
                return self._client
            api_key = (os.getenv("MEM0_API_KEY") or "").strip()
            if not api_key:
                raise Mem0ContractError("mem0_api_key_missing")
            org_id = (os.getenv("MEM0_ORG_ID") or "").strip()
            project_id = (os.getenv("MEM0_PROJECT_ID") or "").strip()
            expected_project = (os.getenv("SOPHIA_MEMORY_PROVIDER_PROJECT") or "").strip()
            if expected_project and project_id != expected_project:
                raise Mem0ContractError("mem0_provider_project_mismatch")
            # Architecture tests allow this import only in this adapter.
            from mem0 import MemoryClient

            self._client = MemoryClient(
                api_key=api_key,
                host=None,
                org_id=org_id or None,
                project_id=project_id or None,
            )
            return self._client

    @staticmethod
    def _results(value: object) -> list[dict[str, Any]]:
        if isinstance(value, dict):
            nested = value.get("results", value.get("memories", []))
            if isinstance(nested, list):
                return [item for item in nested if isinstance(item, dict)]
            return [nested] if isinstance(nested, dict) else []
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
        return []

    def project_revision(
        self,
        *,
        canonical_content: str,
        provider_subject: str,
        metadata: dict[str, object],
    ) -> ProviderMutationResult:
        if not canonical_content or not metadata.get("projection_operation_id"):
            raise Mem0ContractError("mem0_projection_payload_invalid")
        try:
            response = self._get_client().add(
                messages=[{"role": "user", "content": canonical_content}],
                user_id=provider_subject,
                metadata=metadata,
                infer=False,
                async_mode=False,
            )
        except TimeoutError as exc:
            raise Mem0ContractError("mem0_timeout", retryable=True, ambiguous_effect=True) from exc
        except Exception as exc:
            raise Mem0ContractError("mem0_mutation_failed", retryable=True) from exc
        ids = tuple(str(item["id"]) for item in self._results(response) if isinstance(item.get("id"), str) and item["id"])
        if not ids:
            raise Mem0ContractError("mem0_create_missing_id", ambiguous_effect=True)
        verified: list[str] = []
        for provider_id in ids:
            try:
                stored = self._get_client().get(provider_id)
            except Exception as exc:
                raise Mem0ContractError(
                    "mem0_create_verification_failed",
                    retryable=True,
                    ambiguous_effect=True,
                    provider_ids=ids,
                ) from exc
            stored_meta = stored.get("metadata") if isinstance(stored, dict) else None
            if not isinstance(stored_meta, dict) or any(stored_meta.get(key) != value for key, value in metadata.items()):
                raise Mem0ContractError(
                    "mem0_initial_metadata_not_preserved",
                    ambiguous_effect=True,
                    provider_ids=ids,
                )
            verified.append(provider_id)
        return ProviderMutationResult(status="created", provider_ids=tuple(verified), metadata_verified=True)

    def search_ids(
        self,
        *,
        query: str,
        provider_subject: str,
        metadata_filter: dict[str, object],
        limit: int,
    ) -> tuple[ProviderHit, ...]:
        bounded_limit = min(max(limit, 1), 100)
        filters: dict[str, object] = {"user_id": provider_subject}
        filters.update(metadata_filter)
        try:
            response = self._get_client().search(query=query, filters=filters, limit=bounded_limit)
        except Exception as exc:
            raise Mem0ContractError("mem0_search_unavailable", retryable=True) from exc
        hits: list[ProviderHit] = []
        for item in self._results(response):
            provider_id = item.get("id")
            if not isinstance(provider_id, str) or not provider_id:
                continue
            score = item.get("score", item.get("relevance_score"))
            hits.append(
                ProviderHit(
                    provider_memory_id=provider_id,
                    score=float(score) if isinstance(score, (int, float)) else None,
                )
            )
        return tuple(hits)

    def find_by_operation_marker(
        self,
        *,
        provider_subject: str,
        projection_operation_id: str,
        expected_metadata: dict[str, object] | None = None,
        page_size: int = 100,
        max_pages: int = 100,
    ) -> tuple[str, ...]:
        found: list[str] = []
        for rows in self._all_pages(
            provider_subject=provider_subject,
            page_size=page_size,
            max_pages=max_pages,
        ):
            for item in rows:
                metadata = item.get("metadata")
                if isinstance(metadata, dict) and metadata.get("projection_operation_id") == projection_operation_id:
                    # Hosted list metadata stringifies booleans/integers. Use it
                    # only for discovery; authorize reconciliation against the
                    # pinned exact-ID readback, without coercing binding types.
                    provider_id = item.get("id")
                    if not isinstance(provider_id, str) or not provider_id:
                        raise Mem0ContractError("mem0_operation_marker_metadata_conflict", ambiguous_effect=True)
                    try:
                        stored = self._get_client().get(provider_id)
                    except Exception as exc:
                        raise Mem0ContractError("mem0_operation_marker_verification_failed", retryable=True, ambiguous_effect=True) from exc
                    stored_metadata = stored.get("metadata") if isinstance(stored, dict) else None
                    required = {**(expected_metadata or {}), "projection_operation_id": projection_operation_id}
                    if (
                        not isinstance(stored, dict)
                        or stored.get("id") != provider_id
                        or not isinstance(stored_metadata, dict)
                        or any(type(stored_metadata.get(key)) is not type(value) or stored_metadata.get(key) != value for key, value in required.items())
                    ):
                        raise Mem0ContractError(
                            "mem0_operation_marker_metadata_conflict",
                            ambiguous_effect=True,
                        )
                    found.append(provider_id)
        return tuple(dict.fromkeys(found))

    def _all_pages(
        self,
        *,
        provider_subject: str,
        page_size: int = 100,
        max_pages: int = 100,
    ) -> Iterable[list[dict[str, Any]]]:
        for page in range(1, max_pages + 1):
            try:
                response = self._get_client().get_all(
                    filters={"user_id": provider_subject},
                    page=page,
                    page_size=page_size,
                )
            except Exception as exc:
                raise Mem0ContractError("mem0_pagination_unavailable", retryable=True) from exc
            rows = self._results(response)
            yield rows
            if len(rows) < page_size:
                return
        raise Mem0ContractError("mem0_pagination_incomplete")

    def delete_ids(
        self,
        provider_ids: Iterable[str],
        *,
        provider_subject: str,
    ) -> ProviderMutationResult:
        deleted: list[str] = []
        targets = tuple(dict.fromkeys(provider_ids))
        present_before = {str(item.get("id")) for rows in self._all_pages(provider_subject=provider_subject) for item in rows if item.get("id")}
        for provider_id in targets:
            if provider_id not in present_before:
                deleted.append(provider_id)
                continue
            try:
                self._get_client().delete(provider_id)
            except Exception as exc:
                raise Mem0ContractError("mem0_delete_failed", retryable=True, provider_ids=tuple(deleted)) from exc
            deleted.append(provider_id)
        remaining_ids = {str(item.get("id")) for rows in self._all_pages(provider_subject=provider_subject) for item in rows if item.get("id")}
        still_present = tuple(provider_id for provider_id in targets if provider_id in remaining_ids)
        if still_present:
            raise Mem0ContractError(
                "mem0_delete_not_verified",
                retryable=True,
                provider_ids=still_present,
            )
        return ProviderMutationResult(status="deleted", provider_ids=tuple(deleted), metadata_verified=True)
