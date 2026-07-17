from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from deerflow.sophia.storage.async_supabase_object_store import (
    AsyncSupabaseImmutableObjectStore,
)
from deerflow.sophia.storage.supabase_artifact_store import (
    ArtifactObjectSizeError,
)


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key")
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "artifacts")


@pytest.mark.anyio
async def test_read_bounded_accepts_exact_missing_shape_and_rejects_size() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/missing.bin"):
            return httpx.Response(
                400,
                json={
                    "statusCode": "404",
                    "error": "not_found",
                    "message": "Object not found",
                },
            )
        return httpx.Response(200, content=b"12345")

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        assert await store.read_bounded("dq1/inbox/v1/missing.bin", max_bytes=8) is None
        with pytest.raises(ArtifactObjectSizeError):
            await store.read_bounded("dq1/inbox/v1/large.bin", max_bytes=4)


@pytest.mark.anyio
async def test_create_conflict_is_exists_only_after_exact_head() -> None:
    requests: list[tuple[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, request.url.path))
        if request.method == "POST":
            return httpx.Response(409)
        if request.method == "GET":
            return httpx.Response(200, content=b"x")
        raise AssertionError(request.method)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        result = await store.create_if_absent(
            "dq1/inbox/v1/quality_" + "a" * 64 + ".bin",
            b"bundle",
            content_type="application/octet-stream",
        )

    assert result == "exists"
    assert [method for method, _path in requests] == ["POST", "GET"]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    (
        {"code": "NoSuchBucket", "message": "bucket absent"},
        {"code": "TenantNotFound", "message": "tenant absent"},
        {"message": "unknown route"},
    ),
)
async def test_read_never_confuses_other_404s_with_missing_object(
    payload: dict[str, str],
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json=payload)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        with pytest.raises(httpx.HTTPStatusError):
            await store.read_bounded("dq1/inbox/v1/item.bin", max_bytes=8)


@pytest.mark.anyio
async def test_read_accepts_only_exact_current_key_missing_code() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            404,
            json={"code": "NoSuchKey", "message": "key absent"},
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        assert await store.read_bounded(
            "dq1/inbox/v1/item.bin",
            max_bytes=8,
        ) is None


@pytest.mark.anyio
async def test_flat_page_is_oldest_first_and_one_level_only() -> None:
    request_json: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        request_json.update(json.loads(await request.aread()))
        return httpx.Response(
            200,
            json=[
                {"id": "1", "name": "quality_" + "a" * 64 + ".bin"},
                {"id": "2", "name": "quality_" + "b" * 64 + ".bin"},
            ],
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        paths = await store.list_flat_page("dq1/inbox/v1", limit=32)

    assert paths == [
        "dq1/inbox/v1/quality_" + "a" * 64 + ".bin",
        "dq1/inbox/v1/quality_" + "b" * 64 + ".bin",
    ]
    assert request_json["limit"] == 32
    assert request_json["offset"] == 0
    assert request_json["sortBy"] == {"column": "name", "order": "asc"}


class _DribblingStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        while True:
            await asyncio.sleep(0.001)
            yield b"x"


class _OversizedStream(httpx.AsyncByteStream):
    async def __aiter__(self):
        for _ in range(600):
            yield b"x" * 1024


@pytest.mark.anyio
async def test_caller_absolute_deadline_cancels_slow_dribbling_stream() -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=_DribblingStream())

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=None,
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.025):
                await store.read_bounded(
                    "dq1/inbox/v1/quality_" + "c" * 64 + ".bin",
                    max_bytes=1024 * 1024,
                )
        elapsed = time.monotonic() - started

    assert elapsed < 0.2


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("records", "expected"),
    (([{"name": "dq1/inbox/v1/item.bin"}], "deleted"), ([], "missing")),
)
async def test_delete_if_present_is_idempotent(
    records: list[dict[str, str]],
    expected: str,
) -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        assert json.loads(await request.aread()) == {
            "prefixes": ["dq1/inbox/v1/item.bin"]
        }
        return httpx.Response(200, json=records)

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler)
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        assert (
            await store.delete_if_present("dq1/inbox/v1/item.bin")
            == expected
        )


@pytest.mark.anyio
@pytest.mark.parametrize("method", ("list", "delete"))
async def test_list_and_delete_stream_responses_under_decoded_byte_ceiling(
    method: str,
) -> None:
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=_OversizedStream())

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(handler),
        timeout=None,
    ) as client:
        store = AsyncSupabaseImmutableObjectStore(client=client)
        with pytest.raises(RuntimeError, match="response body is oversized"):
            if method == "list":
                await store.list_flat_page("dq1/inbox/v1", limit=32)
            else:
                await store.delete_if_present("dq1/inbox/v1/item.bin")
