"""Cancellable service-role Supabase object operations for DQ-1.

The ordinary artifact helpers are synchronous because most builder call sites
are synchronous. DQ-1 has stricter isolation requirements: a slow-dribbling
storage response must obey one caller-owned absolute deadline rather than an
inactivity timeout per HTTP phase. These native async operations propagate
``asyncio`` cancellation into httpx so the producer and reconciler can enforce
that deadline without accumulating abandoned executor threads.
"""

from __future__ import annotations

import json
import mimetypes
from typing import Literal

import httpx

from deerflow.sophia.storage.supabase_artifact_store import (
    _CREATE_ONLY_CONFLICT_STATUS_CODES,
    _MAX_INTERNAL_LIST_PAGE_SIZE,
    _MAX_STORAGE_ERROR_BODY_BYTES,
    ArtifactObjectSizeError,
    _internal_list_record_path,
    _is_folder_record,
    _list_url,
    _load_service_role_config,
    _object_url,
    _record_name,
    normalize_object_path,
)

_DEFAULT_INACTIVITY_TIMEOUT_SECONDS = 15.0
_MAX_FLAT_LIST_RESPONSE_BYTES = 512 * 1024
_MAX_DELETE_RESPONSE_BYTES = 64 * 1024


class AsyncSupabaseImmutableObjectStore:
    """Native-async, service-role-only immutable object store.

    Methods intentionally do not invent their own total timeout. The caller
    wraps a complete multi-request protocol in ``asyncio.timeout_at`` so one
    absolute deadline covers DNS/connect, request upload, response streaming,
    ambiguity reconciliation, and every sequential request.
    """

    def __init__(self, *, client: httpx.AsyncClient | None = None) -> None:
        config = _load_service_role_config()
        if config is None:
            raise RuntimeError("Supabase service-role artifact storage is not configured")
        self._config = config
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=_DEFAULT_INACTIVITY_TIMEOUT_SECONDS)

    def _headers(self, *, content_type: str | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._config.service_role_key}",
            "apikey": self._config.service_role_key,
            "Accept-Encoding": "identity",
        }
        if content_type is not None:
            headers.update(
                {
                    "Content-Type": content_type,
                    "Cache-Control": "no-cache",
                }
            )
        return headers

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    @staticmethod
    async def _bounded_response_body(
        response: httpx.Response,
        *,
        max_bytes: int,
    ) -> bytes:
        content_encoding = response.headers.get("content-encoding", "identity")
        if content_encoding.casefold().strip() not in {"", "identity"}:
            raise RuntimeError("Supabase encoded response is not accepted")
        content_length = response.headers.get("content-length")
        if content_length is not None:
            try:
                if int(content_length) > max_bytes:
                    raise RuntimeError("Supabase response body is oversized")
            except ValueError:
                raise RuntimeError("Supabase response content length is invalid") from None
        body = bytearray()
        async for chunk in response.aiter_bytes():
            if len(body) + len(chunk) > max_bytes:
                raise RuntimeError("Supabase response body is oversized")
            body.extend(chunk)
        return bytes(body)

    async def _is_missing_response(self, response: httpx.Response) -> bool:
        if response.status_code not in {400, 404}:
            return False
        try:
            body = await self._bounded_response_body(
                response,
                max_bytes=_MAX_STORAGE_ERROR_BODY_BYTES,
            )
            payload = json.loads(body)
        except (RuntimeError, TypeError, ValueError):
            return False
        if not isinstance(payload, dict):
            return False
        # Supabase's current Storage errors distinguish a missing object
        # (NoSuchKey) from a missing bucket, tenant, route, or upload even
        # though all can use HTTP 404. Only the exact key-missing code is safe
        # to interpret as an absent object.
        code = str(payload.get("code", "")).strip()
        if response.status_code == 404 and code == "NoSuchKey":
            return True
        status_code = str(payload.get("statusCode", "")).strip()
        error = str(payload.get("error", "")).strip().casefold().replace("-", "_").replace(" ", "_")
        message = " ".join(str(payload.get("message", "")).strip().casefold().split())
        return bool(status_code == "404" and error == "not_found" and message == "object not found")

    async def read_bounded(
        self,
        object_path: str,
        *,
        max_bytes: int,
    ) -> bytes | None:
        if not 1 <= max_bytes <= 128 * 1024 * 1024:
            raise ValueError("object read budget must be between 1 byte and 128 MiB")
        normalized_path = normalize_object_path(object_path)
        async with self._client.stream(
            "GET",
            _object_url(self._config, normalized_path),
            headers=self._headers(),
        ) as response:
            if await self._is_missing_response(response):
                return None
            response.raise_for_status()
            content_encoding = response.headers.get(
                "content-encoding",
                "identity",
            )
            if content_encoding.casefold().strip() not in {"", "identity"}:
                raise RuntimeError("Supabase encoded object response is not accepted")
            content_length = response.headers.get("content-length")
            if content_length is not None:
                try:
                    declared_size = int(content_length)
                except ValueError:
                    declared_size = -1
                if declared_size < 0 or declared_size > max_bytes:
                    raise ArtifactObjectSizeError("remote object exceeds its read budget")
            content = bytearray()
            async for chunk in response.aiter_bytes():
                if len(content) + len(chunk) > max_bytes:
                    raise ArtifactObjectSizeError("remote object exceeds its read budget")
                content.extend(chunk)
            return bytes(content)

    async def exists(self, object_path: str) -> bool:
        try:
            content = await self.read_bounded(object_path, max_bytes=1)
        except ArtifactObjectSizeError:
            return True
        return content is not None

    async def create_if_absent(
        self,
        object_path: str,
        content: bytes,
        *,
        content_type: str,
    ) -> Literal["created", "exists"]:
        normalized_path = normalize_object_path(object_path)
        mime_type = content_type or mimetypes.guess_type(normalized_path)[0] or "application/octet-stream"
        headers = self._headers(content_type=mime_type)
        headers["x-upsert"] = "false"
        async with self._client.stream(
            "POST",
            _object_url(self._config, normalized_path),
            content=content,
            headers=headers,
        ) as response:
            conflict = response.status_code in _CREATE_ONLY_CONFLICT_STATUS_CODES
            if not conflict:
                response.raise_for_status()
        # Release the POST response/connection before the exact GET fence. A
        # one-connection pool would otherwise deadlock waiting for itself.
        if conflict:
            if await self.exists(normalized_path):
                return "exists"
            response.raise_for_status()
        return "created"

    async def list_flat_page(
        self,
        prefix: str,
        *,
        limit: int,
    ) -> list[str]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= _MAX_INTERNAL_LIST_PAGE_SIZE:
            raise ValueError(f"limit must be between 1 and {_MAX_INTERNAL_LIST_PAGE_SIZE}")
        normalized_root = normalize_object_path(prefix)
        root_prefix = f"{normalized_root}/"
        async with self._client.stream(
            "POST",
            _list_url(self._config),
            headers=self._headers(content_type="application/json"),
            json={
                "prefix": root_prefix,
                "limit": limit,
                "offset": 0,
                "sortBy": {"column": "name", "order": "asc"},
            },
        ) as response:
            response.raise_for_status()
            body = await self._bounded_response_body(
                response,
                max_bytes=_MAX_FLAT_LIST_RESPONSE_BYTES,
            )
        try:
            data = json.loads(body)
        except (TypeError, ValueError):
            raise RuntimeError("Supabase flat listing returned invalid JSON") from None
        if not isinstance(data, list) or len(data) > limit:
            raise RuntimeError("Supabase flat listing returned an invalid shape")
        paths: list[str] = []
        for item in data:
            if not isinstance(item, dict) or _is_folder_record(item):
                raise RuntimeError("Supabase flat listing contained a folder")
            raw_name = _record_name(item)
            if raw_name is None:
                raise RuntimeError("Supabase flat listing record has no name")
            object_path = _internal_list_record_path(
                root_prefix=root_prefix,
                current_prefix=root_prefix,
                raw_name=raw_name,
            )
            relative = object_path.removeprefix(root_prefix)
            if not relative or "/" in relative:
                raise RuntimeError("Supabase flat listing escaped one level")
            if object_path in paths:
                raise RuntimeError("Supabase flat listing is duplicated")
            paths.append(object_path)
        return paths

    async def delete_if_present(
        self,
        object_path: str,
    ) -> Literal["deleted", "missing"]:
        normalized_path = normalize_object_path(object_path)
        async with self._client.stream(
            "DELETE",
            f"{self._config.url}/storage/v1/object/{self._config.bucket}",
            headers=self._headers(content_type="application/json"),
            json={"prefixes": [normalized_path]},
        ) as response:
            response.raise_for_status()
            body = await self._bounded_response_body(
                response,
                max_bytes=_MAX_DELETE_RESPONSE_BYTES,
            )
        try:
            deleted = json.loads(body)
        except (TypeError, ValueError):
            raise RuntimeError("Supabase artifact deletion returned invalid JSON") from None
        if deleted == []:
            return "missing"
        if not isinstance(deleted, list) or len(deleted) != 1:
            raise RuntimeError("Supabase artifact deletion returned an invalid result")
        record = deleted[0]
        if not isinstance(record, dict) or _record_name(record) != normalized_path:
            raise RuntimeError("Supabase artifact deletion did not acknowledge the exact object")
        return "deleted"
