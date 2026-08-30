"""Unit tests for the Supabase artifact store adapter."""

from __future__ import annotations

import hashlib
import json

import httpx
import pytest

from deerflow.sophia.storage import supabase_artifact_store


@pytest.fixture(autouse=True)
def _clear_supabase_env(monkeypatch):
    for var in (
        "RENDER",
        "VERCEL",
        "RAILWAY_ENVIRONMENT",
        "SOPHIA_ENV",
        "APP_ENV",
        "ENVIRONMENT",
        "SOPHIA_ARTIFACT_REGISTRY_STORE",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SUPABASE_KEY",
        "SUPABASE_BUILDER_BUCKET",
    ):
        monkeypatch.delenv(var, raising=False)


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "svc-role-key")


def test_is_configured_false_when_env_missing() -> None:
    assert supabase_artifact_store.is_configured() is False


def test_is_configured_true_when_env_present(monkeypatch) -> None:
    _configure(monkeypatch)
    assert supabase_artifact_store.is_configured() is True


def test_production_supabase_registry_requires_explicit_bucket(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("SOPHIA_ARTIFACT_REGISTRY_STORE", "supabase")

    assert supabase_artifact_store.is_configured() is False
    assert "SUPABASE_BUILDER_BUCKET" in supabase_artifact_store.missing_required_config()


def test_builder_artifact_object_path_is_user_scoped_and_sanitized() -> None:
    object_path = supabase_artifact_store.builder_artifact_object_path(
        user_id="auth0|user/one",
        thread_or_session_id="thread/../one",
        artifact_id="artifact_abc123",
        filename="../Quarterly Report ?.md",
    )

    assert object_path.startswith("artifacts/auth0_user_one/")
    assert "/artifact_abc123/" in object_path
    assert object_path.endswith(".md")
    assert ".." not in object_path.split("/")
    assert "?" not in object_path


def test_builder_artifact_object_path_separates_users_with_same_filename() -> None:
    first = supabase_artifact_store.builder_artifact_object_path(
        user_id="user-a",
        thread_or_session_id="thread-1",
        artifact_id="artifact-same",
        filename="report.md",
    )
    second = supabase_artifact_store.builder_artifact_object_path(
        user_id="user-b",
        thread_or_session_id="thread-1",
        artifact_id="artifact-same",
        filename="report.md",
    )

    assert first != second
    assert first == "artifacts/user-a/thread-1/artifact-same/report.md"
    assert second == "artifacts/user-b/thread-1/artifact-same/report.md"


def test_immutable_builder_artifact_path_is_public_version_and_hash_bound() -> None:
    artifact_sha256 = "a" * 64
    version_digest = hashlib.sha256(b"artifact-version-1").hexdigest()
    object_path = supabase_artifact_store.immutable_builder_artifact_object_path(
        user_id="user-1",
        thread_or_session_id="thread-1",
        logical_artifact_id="logical-1",
        artifact_version_id="artifact-version-1",
        artifact_sha256=artifact_sha256,
        filename="deck.pptx",
    )
    changed_version = supabase_artifact_store.immutable_builder_artifact_object_path(
        user_id="user-1",
        thread_or_session_id="thread-1",
        logical_artifact_id="logical-1",
        artifact_version_id="artifact-version-2",
        artifact_sha256=artifact_sha256,
        filename="deck.pptx",
    )
    changed_hash = supabase_artifact_store.immutable_builder_artifact_object_path(
        user_id="user-1",
        thread_or_session_id="thread-1",
        logical_artifact_id="logical-1",
        artifact_version_id="artifact-version-1",
        artifact_sha256="b" * 64,
        filename="deck.pptx",
    )

    assert object_path == (
        "artifacts/user-1/thread-1/logical-1/versions/"
        f"{version_digest}/{artifact_sha256}/deck.pptx"
    )
    assert "/.builder/" not in object_path
    assert changed_version != object_path
    assert changed_hash != object_path


@pytest.mark.parametrize(
    "kwargs",
    [
        {"artifact_sha256": "A" * 64},
        {"artifact_sha256": "a" * 63},
        {"artifact_version_id": ""},
        {"logical_artifact_id": "  "},
    ],
)
def test_immutable_builder_artifact_path_rejects_invalid_identity(kwargs) -> None:
    values = {
        "user_id": "user-1",
        "thread_or_session_id": "thread-1",
        "logical_artifact_id": "logical-1",
        "artifact_version_id": "artifact-version-1",
        "artifact_sha256": "a" * 64,
        "filename": "deck.pptx",
    }
    values.update(kwargs)

    with pytest.raises(ValueError, match="identity|SHA-256"):
        supabase_artifact_store.immutable_builder_artifact_object_path(**values)


def test_upload_noop_when_not_configured() -> None:
    result = supabase_artifact_store.upload_artifact(thread_id="thread-1", filename="note.md", content=b"hello")
    assert result is None


def test_upload_posts_to_thread_folder_with_defaults(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["content"] = request.content
        return httpx.Response(200, json={"Key": "sophia-builder-artifacts/thread-1/note.md"})

    transport = httpx.MockTransport(handler)
    client = httpx.Client(transport=transport)

    object_path = supabase_artifact_store.upload_artifact(
        thread_id="thread-1",
        filename="note.md",
        content=b"hello",
        client=client,
    )

    assert object_path == "thread-1/note.md"
    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/thread-1/note.md")
    headers = captured["headers"]
    assert headers["authorization"] == "Bearer svc-role-key"
    assert headers["apikey"] == "svc-role-key"
    assert headers["x-upsert"] == "true"
    assert headers["content-type"] == "text/markdown"
    assert captured["content"] == b"hello"


def test_upload_honors_custom_bucket(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setenv("SUPABASE_BUILDER_BUCKET", "custom_bucket")

    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    supabase_artifact_store.upload_artifact(thread_id="thread-2", filename="deck.pptx", content=b"x", client=client)

    assert "/storage/v1/object/custom_bucket/thread-2/deck.pptx" in captured["url"]


def test_upload_encodes_object_path_segments(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = supabase_artifact_store.upload_artifact(
        thread_id="thread-1",
        filename="reports/report #1?.pdf",
        content=b"x",
        client=client,
    )

    assert object_path == "thread-1/reports/report #1?.pdf"
    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/thread-1/reports/report%20%231%3F.pdf")


def test_upload_artifact_object_posts_to_explicit_safe_path(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["content"] = request.content
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = supabase_artifact_store.upload_artifact_object(
        "artifacts/user-1/session-1/artifact-1/report #1.md",
        b"# report",
        content_type="text/markdown",
        client=client,
    )

    assert object_path == "artifacts/user-1/session-1/artifact-1/report #1.md"
    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/artifacts/user-1/session-1/artifact-1/report%20%231.md")
    assert captured["content"] == b"# report"


def test_create_artifact_object_if_absent_uses_create_only_upload(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        captured["content"] = request.content
        return httpx.Response(201)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.create_artifact_object_if_absent(
        "artifacts/user-1/session-1/quality/run/evidence.json",
        b'{"safe":true}',
        content_type="application/json",
        client=client,
    )

    assert result == "created"
    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/artifacts/user-1/session-1/quality/run/evidence.json")
    headers = captured["headers"]
    assert headers["x-upsert"] == "false"
    assert headers["content-type"] == "application/json"
    assert captured["content"] == b'{"safe":true}'


@pytest.mark.parametrize("conflict_status", [400, 409])
def test_create_artifact_object_if_absent_confirms_existing_without_parsing_error_body(
    monkeypatch,
    caplog,
    conflict_status: int,
) -> None:
    _configure(monkeypatch)
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.method)
        if request.method == "POST":
            return httpx.Response(conflict_status, content=b"secret-response-payload")
        assert request.method == "HEAD"
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.create_artifact_object_if_absent(
        "artifacts/user-1/session-1/quality/run/evidence.json",
        b"immutable",
        client=client,
    )

    assert result == "exists"
    assert requests == ["POST", "HEAD"]
    assert "secret-response-payload" not in caplog.text


def test_create_artifact_object_if_absent_does_not_mask_non_duplicate_failure(
    monkeypatch,
    caplog,
) -> None:
    _configure(monkeypatch)
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.method)
        if request.method == "POST":
            return httpx.Response(400, content=b"secret-invalid-request")
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        supabase_artifact_store.create_artifact_object_if_absent(
            "artifacts/user-1/session-1/quality/run/evidence.json",
            b"immutable",
            client=client,
        )

    assert requests == ["POST", "HEAD"]
    assert "secret-invalid-request" not in caplog.text


def test_create_artifact_object_if_absent_raises_unexpected_server_error(monkeypatch) -> None:
    _configure(monkeypatch)
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.method)
        return httpx.Response(503, content=b"unavailable")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.HTTPStatusError):
        supabase_artifact_store.create_artifact_object_if_absent(
            "artifacts/user-1/session-1/quality/run/evidence.json",
            b"immutable",
            client=client,
        )

    assert requests == ["POST"]


def test_supabase_immutable_object_store_adapts_create_and_byte_reads(monkeypatch) -> None:
    _configure(monkeypatch)
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "POST":
            return httpx.Response(201)
        if request.url.path.endswith("/missing.json"):
            return httpx.Response(404)
        return httpx.Response(200, content=b"stored", headers={"content-type": "application/json"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    store = supabase_artifact_store.SupabaseImmutableObjectStore(client=client)

    assert (
        store.create_if_absent(
            "artifacts/user-1/session-1/quality/run/evidence.json",
            b"stored",
            content_type="application/json",
        )
        == "created"
    )
    assert store.read("artifacts/user-1/session-1/quality/run/evidence.json") == b"stored"
    assert store.read("artifacts/user-1/session-1/quality/run/missing.json") is None
    assert methods == ["POST", "GET", "GET"]


def test_artifact_object_path_rejects_traversal_even_when_unconfigured() -> None:
    with pytest.raises(ValueError):
        supabase_artifact_store.download_artifact_object("../secret.md")
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact_object("C:/Users/alice/secret.md", b"x")


def test_download_returns_none_on_404(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(thread_id="thread-1", filename="note.md", client=client)
    assert result is None


def test_download_artifact_object_returns_bytes(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(
            200,
            content=b"stored object",
            headers={"content-type": "text/markdown"},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact_object(
        "artifacts/user-1/session-1/artifact-1/note.md",
        client=client,
    )

    assert result == (b"stored object", "text/markdown")
    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/artifacts/user-1/session-1/artifact-1/note.md")


def test_bounded_artifact_object_read_rejects_declared_oversize(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"oversized",
            headers={"content-length": "9"},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(
        supabase_artifact_store.ArtifactObjectSizeError,
        match="read budget",
    ):
        supabase_artifact_store.download_artifact_object_bounded(
            "artifacts/user-1/session-1/artifact-1/note.md",
            max_bytes=8,
            client=client,
        )


def test_bounded_artifact_object_read_treats_exact_supabase_missing_400_as_absent(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "statusCode": "404",
                "error": "not_found",
                "message": "Object not found",
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    assert (
        supabase_artifact_store.download_artifact_object_bounded(
            "dq1/producer/v1/run-1/envelope.json",
            max_bytes=4096,
            client=client,
        )
        is None
    )


def test_bounded_artifact_object_read_does_not_mask_arbitrary_400(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={
                "statusCode": "400",
                "error": "bad_request",
                "message": "Object path is invalid",
            },
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        supabase_artifact_store.download_artifact_object_bounded(
            "dq1/producer/v1/run-1/envelope.json",
            max_bytes=4096,
            client=client,
        )


def test_immutable_store_bounded_read_rejects_chunked_oversize(monkeypatch) -> None:
    _configure(monkeypatch)

    class ChunkedStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"five"
            yield b"bytes"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=ChunkedStream())

    client = httpx.Client(transport=httpx.MockTransport(handler))
    store = supabase_artifact_store.SupabaseImmutableObjectStore(client=client)
    with pytest.raises(
        supabase_artifact_store.ArtifactObjectSizeError,
        match="read budget",
    ):
        store.read_bounded(
            "artifacts/user-1/session-1/artifact-1/note.md",
            max_bytes=8,
        )


def test_service_role_flat_page_returns_one_exact_bounded_page(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json=[
                {"name": "run-b.bin", "id": "b", "metadata": {"size": 2}},
                {
                    "name": "dq1/producer-inbox/v1/run-a.bin",
                    "id": "a",
                    "metadata": {"size": 1},
                },
            ],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))

    paths = supabase_artifact_store.list_artifact_object_paths_flat_page(
        "dq1/producer-inbox/v1",
        limit=2,
        client=client,
    )

    assert paths == [
        "dq1/producer-inbox/v1/run-a.bin",
        "dq1/producer-inbox/v1/run-b.bin",
    ]
    assert len(captured) == 1
    request = captured[0]
    assert request.method == "POST"
    assert str(request.url) == (
        "https://example.supabase.co/storage/v1/object/list/"
        "sophia-builder-artifacts"
    )
    assert json.loads(request.content) == {
        "prefix": "dq1/producer-inbox/v1/",
        "limit": 2,
        "offset": 0,
        "sortBy": {"column": "name", "order": "asc"},
    }
    assert request.headers["authorization"] == "Bearer svc-role-key"


@pytest.mark.parametrize(
    "records",
    [
        [{"name": "nested", "id": None, "metadata": None}],
        [{"name": "nested/run.bin", "id": "nested", "metadata": {}}],
    ],
)
def test_service_role_flat_page_rejects_nested_records(
    monkeypatch,
    records,
) -> None:
    _configure(monkeypatch)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json=records)
        )
    )

    with pytest.raises(
        supabase_artifact_store.ArtifactObjectListLimitError,
        match="nested",
    ):
        supabase_artifact_store.list_artifact_object_paths_flat_page(
            "dq1/producer-inbox/v1",
            limit=2,
            client=client,
        )


@pytest.mark.parametrize("record", ["run.bin", {}, {"id": "run"}])
def test_service_role_flat_page_rejects_malformed_records(
    monkeypatch,
    record,
) -> None:
    _configure(monkeypatch)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json=[record])
        )
    )

    with pytest.raises(RuntimeError, match="malformed|nameless"):
        supabase_artifact_store.list_artifact_object_paths_flat_page(
            "dq1/producer-inbox/v1",
            limit=2,
            client=client,
        )


@pytest.mark.parametrize(
    ("response_records", "expected"),
    [
        (
            [
                {
                    "name": "dq1/producer-inbox/v1/run-1.bin",
                    "id": "object-id",
                }
            ],
            "deleted",
        ),
        ([], "missing"),
    ],
)
def test_service_role_delete_uses_bucket_scoped_prefix_contract(
    monkeypatch,
    response_records,
    expected,
) -> None:
    _configure(monkeypatch)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=response_records)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.delete_artifact_object_if_present(
        "dq1/producer-inbox/v1/run-1.bin",
        client=client,
    )

    assert result == expected
    assert len(captured) == 1
    request = captured[0]
    assert request.method == "DELETE"
    assert str(request.url) == (
        "https://example.supabase.co/storage/v1/object/"
        "sophia-builder-artifacts"
    )
    assert json.loads(request.content) == {
        "prefixes": ["dq1/producer-inbox/v1/run-1.bin"]
    }
    assert request.headers["authorization"] == "Bearer svc-role-key"


def test_service_role_bounded_batch_delete_uses_exact_prefixes(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: list[httpx.Request] = []
    paths = [
        "voice-lab/recovery/run-1/attempt-1.json",
        "voice-lab/recovery/run-1/attempt-2.json",
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json=[{"name": paths[0]}])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    acknowledged = (
        supabase_artifact_store.delete_artifact_objects_if_present_bounded(
            paths,
            client=client,
        )
    )

    assert acknowledged == 1
    assert len(captured) == 1
    assert json.loads(captured[0].content) == {"prefixes": paths}


def test_service_role_bounded_batch_delete_rejects_unexpected_object(
    monkeypatch,
) -> None:
    _configure(monkeypatch)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                json=[{"name": "voice-lab/recovery/other.json"}],
            )
        )
    )

    with pytest.raises(RuntimeError, match="unexpected object"):
        supabase_artifact_store.delete_artifact_objects_if_present_bounded(
            ["voice-lab/recovery/run-1/attempt-1.json"],
            client=client,
        )


@pytest.mark.parametrize(
    "response_records",
    [
        {},
        [{"name": "dq1/producer-inbox/v1/different.bin"}],
        ["dq1/producer-inbox/v1/run-1.bin"],
        [
            {"name": "dq1/producer-inbox/v1/run-1.bin"},
            {"name": "dq1/producer-inbox/v1/run-1.bin"},
        ],
    ],
)
def test_service_role_delete_rejects_ambiguous_acknowledgements(
    monkeypatch,
    response_records,
) -> None:
    _configure(monkeypatch)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json=response_records)
        )
    )

    with pytest.raises(RuntimeError, match="invalid result|exact object"):
        supabase_artifact_store.delete_artifact_object_if_present(
            "dq1/producer-inbox/v1/run-1.bin",
            client=client,
        )


@pytest.mark.parametrize("status_code", [404, 500])
def test_service_role_delete_does_not_treat_http_failures_as_missing(
    monkeypatch,
    status_code,
) -> None:
    _configure(monkeypatch)
    client = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(status_code, json={"message": "failed"})
        )
    )

    with pytest.raises(httpx.HTTPStatusError):
        supabase_artifact_store.delete_artifact_object_if_present(
            "dq1/producer-inbox/v1/run-1.bin",
            client=client,
        )


def test_service_role_delete_propagates_transport_ambiguity(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("response lost", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.ReadError, match="response lost"):
        supabase_artifact_store.delete_artifact_object_if_present(
            "dq1/producer-inbox/v1/run-1.bin",
            client=client,
        )


def test_immutable_store_exposes_flat_page_and_delete(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(
                200,
                json=[{"name": "run-1.bin", "id": "run-1", "metadata": {}}],
            )
        if request.method == "DELETE":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "dq1/producer-inbox/v1/run-1.bin",
                        "id": "run-1",
                    }
                ],
            )
        raise AssertionError(f"unexpected method {request.method}")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    store = supabase_artifact_store.SupabaseImmutableObjectStore(client=client)

    assert store.list_flat_page("dq1/producer-inbox/v1", limit=1) == [
        "dq1/producer-inbox/v1/run-1.bin"
    ]
    assert (
        store.delete_if_present("dq1/producer-inbox/v1/run-1.bin")
        == "deleted"
    )


def test_service_role_bounded_prefix_list_recurses_paginates_and_normalizes(monkeypatch) -> None:
    _configure(monkeypatch)
    requests: list[tuple[str, int]] = []
    authorization_headers: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefix = payload["prefix"]
        offset = payload["offset"]
        requests.append((prefix, offset))
        authorization_headers.append(request.headers["authorization"])
        if prefix == "dq1/producer/v1/" and offset == 0:
            return httpx.Response(
                200,
                json=[
                    {"name": "canary-a", "id": None, "metadata": None},
                    {
                        "name": "dq1/producer/v1/root-envelope.json",
                        "id": "root-envelope",
                        "metadata": {"size": 10},
                    },
                ],
            )
        if prefix == "dq1/producer/v1/" and offset == 2:
            return httpx.Response(200, json=[])
        if prefix == "dq1/producer/v1/canary-a/":
            return httpx.Response(200, json=[{"name": "run-1", "id": None, "metadata": None}])
        if prefix == "dq1/producer/v1/canary-a/run-1/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "envelope.json",
                        "id": "envelope",
                        "metadata": {"size": 20},
                    }
                ],
            )
        raise AssertionError(f"unexpected listing request: {prefix=} {offset=}")

    client = httpx.Client(transport=httpx.MockTransport(handler))

    paths = supabase_artifact_store.list_artifact_object_paths_bounded(
        "dq1/producer/v1",
        max_objects=10,
        max_depth=2,
        page_size=2,
        client=client,
    )

    assert paths == [
        "dq1/producer/v1/canary-a/run-1/envelope.json",
        "dq1/producer/v1/root-envelope.json",
    ]
    assert requests == [
        ("dq1/producer/v1/", 0),
        ("dq1/producer/v1/canary-a/", 0),
        ("dq1/producer/v1/canary-a/run-1/", 0),
        ("dq1/producer/v1/", 2),
    ]
    assert set(authorization_headers) == {"Bearer svc-role-key"}


def test_immutable_store_exposes_minimal_bounded_prefix_list(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        assert payload["prefix"] == "dq1/producer/v1/"
        return httpx.Response(
            200,
            json=[
                {
                    "name": "envelope.json",
                    "id": "envelope",
                    "metadata": {"size": 20},
                }
            ],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    store = supabase_artifact_store.SupabaseImmutableObjectStore(client=client)

    assert store.list_prefix("dq1/producer/v1", max_objects=1, max_depth=0) == [
        "dq1/producer/v1/envelope.json"
    ]


def test_bounded_prefix_list_requires_explicit_service_role_key(monkeypatch) -> None:
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "anon-key")

    with pytest.raises(RuntimeError, match="service-role"):
        supabase_artifact_store.list_artifact_object_paths_bounded(
            "dq1/producer/v1",
            max_objects=10,
            max_depth=2,
        )


def test_bounded_prefix_list_fails_closed_on_object_overflow(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[
                {"name": "first.json", "id": "first", "metadata": {"size": 1}},
                {"name": "second.json", "id": "second", "metadata": {"size": 1}},
            ],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(
        supabase_artifact_store.ArtifactObjectListLimitError,
        match="max_objects",
    ):
        supabase_artifact_store.list_artifact_object_paths_bounded(
            "dq1/producer/v1",
            max_objects=1,
            max_depth=0,
            client=client,
        )


def test_bounded_prefix_list_fails_closed_on_depth_overflow(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[{"name": "run-1", "id": None, "metadata": None}])

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(
        supabase_artifact_store.ArtifactObjectListLimitError,
        match="max_depth",
    ):
        supabase_artifact_store.list_artifact_object_paths_bounded(
            "dq1/producer/v1",
            max_objects=10,
            max_depth=0,
            client=client,
        )


def test_bounded_prefix_list_fails_closed_on_page_overflow(monkeypatch) -> None:
    _configure(monkeypatch)
    monkeypatch.setattr(supabase_artifact_store, "_MAX_INTERNAL_LIST_PAGES", 1)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json=[{"name": "first.json", "id": "first", "metadata": {"size": 1}}],
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(
        supabase_artifact_store.ArtifactObjectListLimitError,
        match="page budget",
    ):
        supabase_artifact_store.list_artifact_object_paths_bounded(
            "dq1/producer/v1",
            max_objects=10,
            max_depth=0,
            page_size=1,
            client=client,
        )


@pytest.mark.parametrize(
    ("kwargs", "bound_name"),
    [
        ({"max_objects": 0, "max_depth": 0}, "max_objects"),
        ({"max_objects": 1, "max_depth": 33}, "max_depth"),
        ({"max_objects": 1, "max_depth": 0, "page_size": 1001}, "page_size"),
    ],
)
def test_bounded_prefix_list_rejects_out_of_range_bounds(monkeypatch, kwargs, bound_name: str) -> None:
    _configure(monkeypatch)

    with pytest.raises(ValueError, match=bound_name):
        supabase_artifact_store.list_artifact_object_paths_bounded(
            "dq1/producer/v1",
            **kwargs,
        )


def test_download_returns_bytes_and_content_type(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"stored",
            headers={"content-type": "text/markdown"},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    result = supabase_artifact_store.download_artifact(thread_id="thread-1", filename="note.md", client=client)

    assert result == (b"stored", "text/markdown")


def test_signed_url_request_encodes_object_path_segments(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        return httpx.Response(200, json={"signedURL": "/object/sign/sophia-builder-artifacts/token"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    supabase_artifact_store.create_signed_url(
        thread_id="thread-1",
        filename="report #1?.pdf",
        client=client,
    )

    assert captured["url"] == ("https://example.supabase.co/storage/v1/object/sign/sophia-builder-artifacts/thread-1/report%20%231%3F.pdf")


def test_signed_url_can_sign_exact_uploaded_object_path(monkeypatch) -> None:
    _configure(monkeypatch)
    captured: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(str(request.url))
        if "/object/sign/" in str(request.url):
            return httpx.Response(200, json={"signedURL": "/object/sign/sophia-builder-artifacts/token"})
        return httpx.Response(200)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = supabase_artifact_store.upload_artifact_object(
        "artifacts/user-1/session-1/artifact-abc/report #1.md",
        b"# report",
        client=client,
    )
    supabase_artifact_store.create_signed_url(
        thread_id="session-1",
        filename="report #1.md",
        object_path=object_path,
        client=client,
    )

    assert captured[0] == ("https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/artifacts/user-1/session-1/artifact-abc/report%20%231.md")
    assert captured[1] == ("https://example.supabase.co/storage/v1/object/sign/sophia-builder-artifacts/artifacts/user-1/session-1/artifact-abc/report%20%231.md")


def test_signed_url_refuses_nested_deck_quality_internal_object(monkeypatch) -> None:
    _configure(monkeypatch)

    def handler(_request: httpx.Request) -> httpx.Response:  # pragma: no cover - must not be reached
        raise AssertionError("internal DQ objects must never reach the public signer")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = (
        "artifacts/user-1/thread-1/foundation/.builder/builds/build-1/"
        "quality/quality-1/publication/source_pack/manifest.json"
    )

    assert (
        supabase_artifact_store.create_signed_url(
            thread_id="thread-1",
            filename="manifest.json",
            object_path=object_path,
            client=client,
        )
        is None
    )


def test_service_role_exact_read_allows_nested_deck_quality_internal_object(monkeypatch) -> None:
    _configure(monkeypatch)
    requested_urls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested_urls.append(str(request.url))
        return httpx.Response(
            200,
            content=b'{"schema":"deck-quality-source-pack/v1"}',
            headers={"content-type": "application/json"},
        )

    client = httpx.Client(transport=httpx.MockTransport(handler))
    object_path = (
        "artifacts/user-1/thread-1/foundation/.builder/builds/build-1/"
        "quality/quality-1/publication/source_pack/manifest.json"
    )

    result = supabase_artifact_store.download_artifact_object(object_path, client=client)

    assert result == (b'{"schema":"deck-quality-source-pack/v1"}', "application/json")
    assert requested_urls == [
        "https://example.supabase.co/storage/v1/object/sophia-builder-artifacts/"
        "artifacts/user-1/thread-1/foundation/.builder/builds/build-1/quality/"
        "quality-1/publication/source_pack/manifest.json"
    ]


def test_list_artifacts_recurses_into_supabase_folder_records(monkeypatch) -> None:
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(
                200,
                json=[
                    {"name": "reports", "id": None, "metadata": None},
                    {
                        "name": "root.md",
                        "id": "file-root",
                        "metadata": {"size": 12, "mimetype": "text/markdown"},
                        "updated_at": "2026-05-27T20:00:00Z",
                    },
                ],
            )
        if payload["prefix"] == "thread-1/reports/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "style.css",
                        "id": "file-style",
                        "metadata": {"size": 34, "mimetype": "text/css"},
                        "updated_at": "2026-05-27T20:01:00Z",
                    },
                ],
            )
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/", "thread-1/reports/"]
    assert [(artifact.filename, artifact.size_bytes, artifact.content_type) for artifact in artifacts] == [
        ("reports/style.css", 34, "text/css"),
        ("root.md", 12, "text/markdown"),
    ]
    assert "reports" not in {artifact.filename for artifact in artifacts}


def test_list_artifacts_does_not_descend_into_nested_deck_quality_keyspace(monkeypatch) -> None:
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefix = payload["prefix"]
        prefixes.append(prefix)
        if prefix == "thread-1/":
            return httpx.Response(
                200,
                json=[
                    {"name": "foundation", "id": None, "metadata": None},
                    {
                        "name": (
                            "foundation/.builder/builds/build-1/quality/quality-1/"
                            "publication/source_pack/manifest.json"
                        ),
                        "id": "flat-internal-file",
                        "metadata": {"size": 4096, "mimetype": "application/json"},
                        "updated_at": "2026-07-16T20:02:00Z",
                    },
                    {
                        "name": "deck.pptx",
                        "id": "deliverable",
                        "metadata": {
                            "size": 8192,
                            "mimetype": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                        },
                        "updated_at": "2026-07-16T20:00:00Z",
                    },
                ],
            )
        if prefix == "thread-1/foundation/":
            return httpx.Response(200, json=[{"name": ".builder", "id": None, "metadata": None}])
        if ".builder" in prefix:  # pragma: no cover - must not be reached
            raise AssertionError("recursive listing entered the internal DQ keyspace")
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/", "thread-1/foundation/"]
    assert [artifact.filename for artifact in artifacts] == ["deck.pptx"]


def test_list_artifacts_excludes_mirrored_uploads(monkeypatch) -> None:
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(
                200,
                json=[
                    {"name": "uploads", "id": None, "metadata": None},
                    {
                        "name": "uploads/leaked-input.pdf",
                        "id": "file-upload-direct",
                        "metadata": {"size": 99, "mimetype": "application/pdf"},
                        "updated_at": "2026-05-27T20:02:00Z",
                    },
                    {
                        "name": "builder-output.md",
                        "id": "file-output",
                        "metadata": {"size": 12, "mimetype": "text/markdown"},
                        "updated_at": "2026-05-27T20:00:00Z",
                    },
                ],
            )
        if payload["prefix"] == "thread-1/uploads/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "photo.png",
                        "id": "file-upload",
                        "metadata": {"size": 34, "mimetype": "image/png"},
                        "updated_at": "2026-05-27T20:01:00Z",
                    },
                ],
            )
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/"]
    assert [artifact.filename for artifact in artifacts] == ["builder-output.md"]


def test_upload_rejects_blank_thread_or_filename(monkeypatch) -> None:
    _configure(monkeypatch)
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(thread_id="  ", filename="note.md", content=b"x")
    with pytest.raises(ValueError):
        supabase_artifact_store.upload_artifact(thread_id="thread-1", filename=" ", content=b"x")


def test_list_artifacts_excludes_delegation_ledger(monkeypatch) -> None:
    """Codex P1 PR #131: the mirrored delegation ledger
    ({thread_id}/ledger/session.jsonl) is internal conversation content —
    it must never surface as a user-facing artifact. The list filter must
    skip both the ledger FOLDER (no recursion into it) and any flat
    ledger-prefixed file record, exactly like the uploads keyspace."""
    _configure(monkeypatch)
    prefixes: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content.decode())
        prefixes.append(payload["prefix"])
        if payload["prefix"] == "thread-1/":
            return httpx.Response(
                200,
                json=[
                    {"name": "ledger", "id": None, "metadata": None},
                    {
                        "name": "ledger/session.jsonl",
                        "id": "file-ledger-direct",
                        "metadata": {"size": 4096, "mimetype": "application/x-ndjson"},
                        "updated_at": "2026-06-11T20:02:00Z",
                    },
                    {
                        "name": "builder-output.md",
                        "id": "file-output",
                        "metadata": {"size": 12, "mimetype": "text/markdown"},
                        "updated_at": "2026-06-11T20:00:00Z",
                    },
                ],
            )
        if payload["prefix"] == "thread-1/ledger/":
            return httpx.Response(
                200,
                json=[
                    {
                        "name": "session.jsonl",
                        "id": "file-ledger",
                        "metadata": {"size": 4096, "mimetype": "application/x-ndjson"},
                        "updated_at": "2026-06-11T20:01:00Z",
                    },
                ],
            )
        return httpx.Response(200, json=[])

    client = httpx.Client(transport=httpx.MockTransport(handler))

    artifacts = supabase_artifact_store.list_artifacts(thread_id="thread-1", client=client)

    assert prefixes == ["thread-1/"]  # never descended into ledger/
    assert [artifact.filename for artifact in artifacts] == ["builder-output.md"]


def test_is_ledger_object_name_covers_keyspace_and_descendants() -> None:
    assert supabase_artifact_store.is_ledger_object_name("ledger/session.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("ledger") is True
    assert supabase_artifact_store.is_ledger_object_name("/ledger/session.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("ledger/sub/dir.jsonl") is True
    assert supabase_artifact_store.is_ledger_object_name("report.pdf") is False
    assert supabase_artifact_store.is_ledger_object_name("ledgers/notes.md") is False
    assert supabase_artifact_store.is_ledger_object_name("uploads/ledger.csv") is False


@pytest.mark.parametrize(
    "path",
    [
        ".builder/builds/build-1/manifest.json",
        "foundation/.builder/builds/build-1/quality/quality-1/publication/source_pack/manifest.json",
        "artifacts/user-1/thread-1/foundation/.builder/builds/build-1/manifest.json",
        "safe/nested/ledger/session.jsonl",
        "safe/nested/uploads/input.pdf",
        r"safe\nested\deck_build\build.json",
    ],
)
def test_internal_artifact_path_detects_reserved_segments_at_any_depth(path) -> None:
    assert supabase_artifact_store.is_internal_artifact_path(path) is True


@pytest.mark.parametrize(
    "path",
    [
        "deck.pptx",
        "foundation/builds/build-1/manifest.json",
        "reports/builder-notes.md",
        "safe/ledgers/session.jsonl",
        "safe/assets-overview.md",
    ],
)
def test_internal_artifact_path_does_not_match_similar_names(path) -> None:
    assert supabase_artifact_store.is_internal_artifact_path(path) is False
