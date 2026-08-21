from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest

from deerflow.sophia.session_store import (
    FilesystemSessionTranscriptStore,
    SessionMessageRecord,
    SessionRecord,
    SessionStore,
    SessionStoreConfigurationError,
    SupabaseSessionStoreConfig,
    SupabaseSessionTranscriptStore,
)


@pytest.fixture(autouse=True)
def _clear_session_store_env(monkeypatch):
    for name in (
        "SOPHIA_SESSION_STORE",
        "SOPHIA_ALLOW_FILESYSTEM_SESSION_STORE_IN_PRODUCTION",
        "SOPHIA_ENV",
        "APP_ENV",
        "ENVIRONMENT",
        "RENDER",
        "RENDER_SERVICE_ID",
        "RENDER_SERVICE_NAME",
        "SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
        "SOPHIA_SESSIONS_TABLE",
        "SOPHIA_SESSION_MESSAGES_TABLE",
    ):
        monkeypatch.delenv(name, raising=False)


def test_session_store_factory_defaults_to_filesystem_locally(tmp_path):
    store = SessionStore(tmp_path)
    assert isinstance(store, FilesystemSessionTranscriptStore)


def test_filesystem_store_appends_messages_idempotently(tmp_path):
    store = SessionStore(tmp_path)
    store.upsert_session(
        SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1")
    )
    first = SessionMessageRecord(
        message_id="msg-1",
        session_id="session-1",
        thread_id="thread-1",
        role="user",
        content="hello",
        sequence=0,
    )
    retry = first.model_copy(update={"content": "hello again"})

    store.append_or_upsert_messages("user-1", "session-1", [first])
    messages = store.append_or_upsert_messages("user-1", "session-1", [retry])

    assert len(messages) == 1
    assert messages[0].content == "hello again"
    assert store.get_session("user-1", "session-1").transcript_available is True


def test_filesystem_revisioned_snapshot_preserves_newer_messages_on_stale_retry(tmp_path):
    store = SessionStore(tmp_path)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    first = SessionMessageRecord(
        message_id="msg-1",
        session_id="session-1",
        thread_id="thread-1",
        role="user",
        content="first",
        sequence=0,
    )
    second = first.model_copy(update={"message_id": "msg-2", "content": "second", "sequence": 1})

    accepted = store.replace_messages_revisioned(
        "user-1", "session-1", [first], expected_revision=0
    )
    assert accepted.accepted is True
    assert accepted.current_revision == 1

    stale = store.replace_messages_revisioned(
        "user-1", "session-1", [first, second], expected_revision=0
    )
    assert stale.conflict is True
    assert stale.current_revision == 2
    assert [message.message_id for message in stale.messages] == ["msg-1", "msg-2"]

    duplicate = store.replace_messages_revisioned(
        "user-1", "session-1", [first, second], expected_revision=2
    )
    assert duplicate.duplicate is True
    assert duplicate.current_revision == 2


def test_filesystem_store_finds_session_by_thread_id(tmp_path):
    store = SessionStore(tmp_path)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    store.upsert_session(SessionRecord(session_id="session-2", thread_id="thread-2", user_id="user-2"))

    record = store.find_session_by_thread_id("user-1", "thread-1")

    assert record is not None
    assert record.session_id == "session-1"
    assert store.find_session_by_thread_id("user-2", "thread-1") is None


class FakeSupabasePostgrest:
    def __init__(self) -> None:
        self.sessions: dict[str, dict] = {}
        self.messages: dict[str, dict] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        table = request.url.path.rstrip("/").split("/")[-1]
        params = {key: values[-1] for key, values in parse_qs(request.url.query.decode()).items()}
        if table == "sophia_sessions":
            return self._handle_sessions(request, params)
        if table == "sophia_session_messages":
            return self._handle_messages(request, params)
        return httpx.Response(404, json={"error": "unknown table"})

    def _json_body(self, request: httpx.Request):
        if not request.content:
            return None
        return json.loads(request.content.decode("utf-8"))

    def _matches(self, row: dict, params: dict[str, str]) -> bool:
        for key in ("id", "user_id", "session_id", "thread_id"):
            value = params.get(key)
            if not value:
                continue
            if value.startswith("eq.") and str(row.get(key)) != value[3:]:
                return False
            if value.startswith("not.in."):
                raw_values = value.removeprefix("not.in.").strip("()")
                blocked = {
                    item.strip().strip('"')
                    for item in raw_values.split(",")
                    if item.strip()
                }
                if str(row.get(key)) in blocked:
                    return False
        return True

    def _handle_sessions(self, request: httpx.Request, params: dict[str, str]) -> httpx.Response:
        if request.method == "POST":
            rows = self._json_body(request) or []
            for row in rows:
                session_id = row["id"]
                merged = dict(self.sessions.get(session_id, {}))
                merged.update(row)
                self.sessions[session_id] = merged
            return httpx.Response(201, json=[self.sessions[row["id"]] for row in rows])

        if request.method == "GET":
            rows = [row for row in self.sessions.values() if self._matches(row, params)]
            rows.sort(key=lambda row: row.get("updated_at") or "", reverse=True)
            limit = params.get("limit")
            if limit:
                rows = rows[: int(limit)]
            return httpx.Response(200, json=rows)

        if request.method == "PATCH":
            patch = self._json_body(request) or {}
            for session_id, row in list(self.sessions.items()):
                if self._matches(row, params):
                    updated = dict(row)
                    updated.update(patch)
                    self.sessions[session_id] = updated
            return httpx.Response(204)

        if request.method == "DELETE":
            for session_id, row in list(self.sessions.items()):
                if self._matches(row, params):
                    self.sessions.pop(session_id, None)
                    for message_id, message in list(self.messages.items()):
                        if message.get("session_id") == session_id:
                            self.messages.pop(message_id, None)
            return httpx.Response(204)

        return httpx.Response(405)

    def _handle_messages(self, request: httpx.Request, params: dict[str, str]) -> httpx.Response:
        if request.method == "POST":
            rows = self._json_body(request) or []
            for row in rows:
                message_id = row["id"]
                merged = dict(self.messages.get(message_id, {}))
                merged.update(row)
                self.messages[message_id] = merged
            return httpx.Response(201)

        if request.method == "GET":
            rows = [row for row in self.messages.values() if self._matches(row, params)]
            rows.sort(key=lambda row: (row.get("sequence", 0), row.get("created_at") or ""))
            return httpx.Response(200, json=rows)

        if request.method == "DELETE":
            for message_id, row in list(self.messages.items()):
                if self._matches(row, params):
                    self.messages.pop(message_id, None)
            return httpx.Response(204)

        return httpx.Response(405)


def _supabase_store(fake: FakeSupabasePostgrest) -> SupabaseSessionTranscriptStore:
    client = httpx.Client(transport=httpx.MockTransport(fake.handler))
    return SupabaseSessionTranscriptStore(
        SupabaseSessionStoreConfig(
            url="https://example.supabase.co",
            service_role_key="service-role",
        ),
        client=client,
    )


def test_supabase_store_upserts_and_lists_sessions():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)

    store.upsert_session(
        SessionRecord(
            session_id="session-1",
            thread_id="thread-1",
            user_id="user-1",
            status="open",
            platform="voice",
            title="Session",
            updated_at="2026-05-26T10:00:00+00:00",
        )
    )

    assert fake.sessions["session-1"]["status"] == "active"
    record = store.get_session("user-1", "session-1")
    assert record is not None
    assert record.status == "open"
    assert record.platform == "voice"
    assert [session.session_id for session in store.list_sessions("user-1")] == ["session-1"]


def test_supabase_store_finds_session_by_thread_id():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    store.upsert_session(SessionRecord(session_id="session-2", thread_id="thread-2", user_id="user-2"))

    record = store.find_session_by_thread_id("user-1", "thread-1")

    assert record is not None
    assert record.session_id == "session-1"
    assert store.find_session_by_thread_id("user-2", "thread-1") is None


def test_supabase_store_append_and_retry_are_idempotent():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    first = SessionMessageRecord(
        message_id="client-msg-1",
        session_id="session-1",
        thread_id="thread-1",
        role="assistant",
        content="draft",
        provider_event_id="provider-event-1",
        sequence=1,
    )
    retry = first.model_copy(update={"content": "final"})

    store.append_or_upsert_messages("user-1", "session-1", [first])
    messages = store.append_or_upsert_messages("user-1", "session-1", [retry])

    assert len(fake.messages) == 1
    assert len(messages) == 1
    assert messages[0].content == "final"
    assert fake.sessions["session-1"]["transcript_available"] is True


def test_supabase_store_replace_messages_upserts_then_removes_stale_rows():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    stale = SessionMessageRecord(
        message_id="stale-greeting",
        session_id="session-1",
        thread_id="thread-1",
        role="assistant",
        content="I'm here with you. What's on your mind?",
        sequence=0,
    )
    canonical = SessionMessageRecord(
        message_id="user-1",
        session_id="session-1",
        thread_id="thread-1",
        role="user",
        content="green harbor notebook",
        sequence=0,
    )

    store.append_or_upsert_messages("user-1", "session-1", [stale])
    messages = store.replace_messages("user-1", "session-1", [canonical])

    assert len(fake.messages) == 1
    assert [message.message_id for message in messages] == ["user-1"]
    assert messages[0].content == "green harbor notebook"


def test_supabase_store_user_boundary_blocks_cross_user_reads():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))
    store.append_or_upsert_messages(
        "user-1",
        "session-1",
        [
            SessionMessageRecord(
                message_id="msg-1",
                session_id="session-1",
                thread_id="thread-1",
                role="user",
                content="private",
            )
        ],
    )

    assert store.get_session("user-2", "session-1") is None
    assert store.list_messages("user-2", "session-1") == []


def test_supabase_store_marks_ended_and_abandoned():
    fake = FakeSupabasePostgrest()
    store = _supabase_store(fake)
    store.upsert_session(SessionRecord(session_id="session-1", thread_id="thread-1", user_id="user-1"))

    ended = store.mark_session_ended("user-1", "session-1")
    assert ended is not None
    assert ended.status == "ended"
    assert ended.ended_at is not None

    abandoned = store.mark_session_abandoned("user-1", "session-1")
    assert abandoned is not None
    assert abandoned.status == "abandoned"


def test_supabase_store_missing_env_has_clear_diagnostic(monkeypatch):
    monkeypatch.setenv("SOPHIA_SESSION_STORE", "supabase")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)

    with pytest.raises(SessionStoreConfigurationError) as exc_info:
        SessionStore()

    message = str(exc_info.value)
    assert "SUPABASE_URL" in message
    assert "SUPABASE_SERVICE_ROLE_KEY" in message
    assert "service-role" not in message


def test_render_runtime_does_not_silently_fall_back_to_filesystem(monkeypatch):
    monkeypatch.setenv("RENDER", "true")

    with pytest.raises(SessionStoreConfigurationError) as exc_info:
        SessionStore()

    assert "SOPHIA_SESSION_STORE=supabase" in str(exc_info.value)
