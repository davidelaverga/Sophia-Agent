from pathlib import Path

from scripts import migrate_supabase_project

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def test_migration_chain_covers_all_application_owned_tables() -> None:
    filenames = (
        "2026_04_25_telegram_user_bindings.sql",
        "2026_05_26_sophia_session_transcripts.sql",
        "2026_06_12_artifact_registry_records.sql",
        "2026_07_11_sophia_build_foundation.sql",
        "2026_07_13_sophia_auth_and_storage_convergence.sql",
    )
    sql = "\n".join((MIGRATIONS / filename).read_text(encoding="utf-8") for filename in filenames)

    for table in (
        "telegram_user_bindings",
        "sophia_sessions",
        "sophia_session_messages",
        "artifact_registry_records",
        "sophia_build_manifest_heads",
        "sophia_build_registry",
        "sophia_build_operation_events",
        "sophia_build_acceptance_outbox",
        "sophia_build_mutation_transactions",
    ):
        assert f"CREATE TABLE IF NOT EXISTS public.{table}" in sql

    for table in ('"user"', '"session"', '"account"', '"verification"'):
        assert f"CREATE TABLE IF NOT EXISTS public.{table}" in sql

    assert "sophia_commit_build_manifest" in sql
    assert "sophia_append_build_event" in sql
    assert "sophia-builder-artifacts" in sql
    assert sql.count("sophia_builder_artifacts_service_role_") >= 4
    assert "CREATE ROLE better_auth_app" in sql
    assert "NOLOGIN" in sql
    assert "GRANT USAGE ON SCHEMA public TO better_auth_app" in sql


def test_target_verification_is_nonpersistent() -> None:
    sql = (MIGRATIONS / "2026_07_13_verify_sophia_target.sql").read_text(encoding="utf-8")

    assert "present_count" in sql
    assert "missing_tables" in sql
    assert "SET LOCAL ROLE service_role;" in sql
    assert "append_and_replay_probe_ok" in sql
    assert "better_auth_builder_events_denied" in sql
    assert sql.rstrip().endswith("ROLLBACK;")


def test_storage_copy_is_resumable_and_hash_verified() -> None:
    class Source:
        @staticmethod
        def download_object(_bucket: str, _path: str) -> bytes:
            return b"authoritative-object"

    class Target:
        content: bytes | None = None
        upload_count = 0

        def download_object_if_present(self, _bucket: str, _path: str) -> bytes | None:
            return self.content

        def upload_object(self, _bucket: str, _path: str, content: bytes, **_kwargs) -> None:
            self.content = content
            self.upload_count += 1

        def download_object(self, _bucket: str, _path: str) -> bytes:
            assert self.content is not None
            return self.content

    target = Target()
    entry = {
        "id": "0ed18f79-c35f-4ec8-987d-83c81cf62db9",
        "created_at": "2026-07-13T10:11:12.123Z",
        "updated_at": "2026-07-13T10:12:13.456+00:00",
        "last_accessed_at": "2026-07-13T10:13:14Z",
        "metadata": {"mimetype": "application/pdf", "size": 20},
    }
    first = migrate_supabase_project._copy_and_verify_object(Source(), target, "source", "thread/deck.pptx", entry)
    second = migrate_supabase_project._copy_and_verify_object(Source(), target, "source", "thread/deck.pptx", entry)

    assert first == second
    assert first[0] == "thread/deck.pptx"
    assert first[2] == len(b"authoritative-object")
    assert target.upload_count == 1


def test_storage_client_separates_control_and_object_timeouts(monkeypatch) -> None:
    transfer_timeouts = []

    class Response:
        status_code = 200
        content = b"payload"

        @staticmethod
        def raise_for_status() -> None:
            return None

        @staticmethod
        def close() -> None:
            return None

    class Client:
        def __init__(self, *, timeout, headers) -> None:
            self.default_timeout = timeout
            self.headers = headers

        @staticmethod
        def request(_method: str, _url: str, **kwargs):
            transfer_timeouts.append(kwargs.get("timeout"))
            return Response()

    monkeypatch.setattr(migrate_supabase_project.httpx, "Client", Client)
    client = migrate_supabase_project.ProjectClient("https://target.example", "test-key")

    assert client.client.default_timeout.read == migrate_supabase_project.CONTROL_PLANE_TIMEOUT_SECONDS
    assert client.download_object("bucket", "path") == b"payload"
    client.upload_object("bucket", "path", b"payload")
    assert [timeout.read for timeout in transfer_timeouts] == [
        migrate_supabase_project.OBJECT_TRANSFER_TIMEOUT_SECONDS,
        migrate_supabase_project.OBJECT_TRANSFER_TIMEOUT_SECONDS,
    ]


def test_restored_storage_metadata_accepts_equivalent_timestamps() -> None:
    source = {
        "id": "0ed18f79-c35f-4ec8-987d-83c81cf62db9",
        "created_at": "2026-07-13T10:11:12.123Z",
        "updated_at": "2026-07-13T10:12:13.456+00:00",
        "last_accessed_at": "2026-07-13T10:13:14Z",
        "metadata": {"mimetype": "application/pdf", "size": 42},
    }
    restored = {
        **source,
        "created_at": "2026-07-13T10:11:12.123000+00:00",
        "last_accessed_at": "2026-07-13T10:13:14+00:00",
    }

    migrate_supabase_project._assert_restored_metadata(source, restored)


def test_generated_storage_metadata_sql_is_scoped_and_exact() -> None:
    entry = {
        "id": "0ed18f79-c35f-4ec8-987d-83c81cf62db9",
        "created_at": "2026-07-13T10:11:12.123Z",
        "updated_at": "2026-07-13T10:12:13.456+00:00",
        "last_accessed_at": "2026-07-13T10:13:14Z",
        "metadata": {"mimetype": "application/pdf", "size": 42},
    }

    sql = migrate_supabase_project._storage_metadata_sql([("thread/deck's source.pptx", entry)])

    assert "SET LOCAL session_replication_role = replica;" in sql
    assert "target.bucket_id = 'sophia-builder-artifacts'" in sql
    assert "thread/deck''s source.pptx" in sql
    assert "target.updated_at IS NOT DISTINCT FROM source.updated_at" in sql
    assert "Builder storage metadata parity check failed" in sql
