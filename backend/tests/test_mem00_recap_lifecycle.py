"""A deleted canonical session cannot leave a readable local recap authority."""

import json
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.gateway.auth import require_authenticated_user
from app.gateway.routers import sessions, sophia
from deerflow.sophia.session_store import SessionRecord


@pytest.fixture
def governed(monkeypatch, tmp_path):
    monkeypatch.setenv("SOPHIA_MEMORY_CANDIDATE_LEDGER_WRITE", "true")
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "owner-1")
    monkeypatch.setattr(sophia, "USERS_DIR", tmp_path)
    record = SessionRecord(user_id="owner-1", session_id="session-1", thread_id="thread-1", message_revision=2)
    store = MagicMock()
    store.get.return_value = record
    monkeypatch.setattr(sophia, "_session_store", store)
    path = tmp_path / "owner-1" / "recaps" / "session-1.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"session_id": "session-1", "thread_id": "thread-1", "_memory_source_revision": ["session-1", "thread-1", 2], "recap_artifacts": {"takeaway": "synthetic"}}))
    return store, record, path


@pytest.mark.parametrize("session_id", ["../other/session", "/absolute", "..", "x\\y"])
def test_recap_path_rejects_session_traversal(governed, session_id):
    with pytest.raises(ValueError):
        sophia._get_session_recap_path("owner-1", session_id)


def test_recap_path_rejects_other_owner_symlink(governed, tmp_path):
    _, _, path = governed
    other = tmp_path / "owner-2"
    other.mkdir()
    target = other / "private.json"
    target.write_text("other-owner")
    path.unlink()
    path.symlink_to(target)
    with pytest.raises(ValueError):
        sophia._get_session_recap_path("owner-1", "session-1")
    assert target.read_text() == "other-owner"


@pytest.mark.parametrize("state", ["missing", "wrong-owner", "outage", "deleted-during-read", "revision-changed"])
def test_governed_recap_read_revalidates_current_canonical_source(governed, state):
    store, record, _ = governed
    if state == "missing":
        store.get.return_value = None
    elif state == "wrong-owner":
        store.get.return_value = record.model_copy(update={"user_id": "owner-2"})
    elif state == "outage":
        store.get.side_effect = RuntimeError("synthetic database unavailable")
    elif state == "deleted-during-read":
        store.get.side_effect = [record, None]
    else:
        store.get.side_effect = [record, record.model_copy(update={"message_revision": 3})]
    assert sophia._read_session_recap("owner-1", "session-1") is None


def test_governed_recap_live_source_is_readable(governed):
    store, _, _ = governed
    assert sophia._read_session_recap("owner-1", "session-1")["session_id"] == "session-1"
    assert store.get.call_count == 2


@pytest.mark.parametrize("phase", ["before-write", "during-write"])
def test_governed_recap_writer_cannot_recreate_deleted_source(governed, phase):
    store, record, path = governed
    path.unlink()
    store.get.side_effect = [None] if phase == "before-write" else [record, None]
    with pytest.raises(OSError, match="recap_source_unavailable"):
        sophia._write_session_recap("owner-1", "session-1", {"session_id": "session-1"})
    assert not path.exists()


def _delete_client(monkeypatch, record):
    app = FastAPI()
    app.include_router(sessions.router)
    app.dependency_overrides[require_authenticated_user] = lambda: "owner-1"
    store = MagicMock()
    store.delete.return_value = record is not None
    monkeypatch.setattr(sessions, "_store", store)
    monkeypatch.setattr(sessions, "_resolve_session_record", lambda *_: ("owner-1", record))
    monkeypatch.setattr(sessions, "_invalidate_memory_source_before_delete", MagicMock())
    monkeypatch.setattr(sessions, "_cleanup_session_ledger", MagicMock())
    return TestClient(app), store


def test_delete_removes_exact_recap_before_parent_and_preserves_other_owner(governed, monkeypatch, tmp_path):
    _, record, path = governed
    other = tmp_path / "owner-2" / "recaps" / "session-1.json"
    other.parent.mkdir(parents=True)
    other.write_text("untouched")
    client, store = _delete_client(monkeypatch, record)

    def delete(*_):
        assert not path.exists()
        return True

    store.delete.side_effect = delete
    response = client.delete("/api/v1/sessions/session-1?user_id=owner-1")
    assert response.status_code == 200
    assert other.read_text() == "untouched"


def test_failed_recap_cleanup_keeps_canonical_parent_retryable(governed, monkeypatch):
    _, record, path = governed
    client, store = _delete_client(monkeypatch, record)
    path.unlink()
    path.mkdir()  # Invalid file shape must fail closed, not recursively purge.
    response = client.delete("/api/v1/sessions/session-1?user_id=owner-1")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "session_recap_cleanup_unavailable"
    store.delete.assert_not_called()


def test_owner_scoped_retry_removes_orphan_but_does_not_invent_parent_success(governed, monkeypatch):
    _, _, path = governed
    client, _ = _delete_client(monkeypatch, None)
    response = client.delete("/api/v1/sessions/session-1?user_id=owner-1")
    assert response.status_code == 404
    assert not path.exists()


def test_wrong_authenticated_owner_cannot_clean_recap(governed, monkeypatch):
    _, record, path = governed
    client, store = _delete_client(monkeypatch, record)
    response = client.delete("/api/v1/sessions/session-1?user_id=owner-2")
    assert response.status_code == 403
    assert path.exists()
    store.delete.assert_not_called()


def test_bulk_delete_keeps_parents_when_any_recap_cleanup_fails(governed, monkeypatch):
    _, record, path = governed
    client, store = _delete_client(monkeypatch, record)
    store.list_sessions.return_value = [record]
    path.unlink()
    path.mkdir()
    response = client.delete("/api/v1/sessions/bulk?user_id=owner-1")
    assert response.status_code == 503
    store.delete_all.assert_not_called()


def test_cleanup_receipt_never_claims_global_erasure(governed, monkeypatch):
    from deerflow.sophia.memory_governance import observability, refs

    _, record, _ = governed
    client, _ = _delete_client(monkeypatch, record)
    event = MagicMock()
    monkeypatch.setattr(observability, "emit_memory_event", event)
    monkeypatch.setattr(refs, "keyed_ref", lambda kind, value: f"hmac-sha256:{kind}:synthetic")
    assert client.delete("/api/v1/sessions/session-1?user_id=owner-1").status_code == 200
    assert event.call_args.args == ("memory.session.recap_cleanup",)
    assert event.call_args.kwargs["privacy_complete"] is False
    assert event.call_args.kwargs["outcome"] == "local_recap_absent"
    assert "owner-1" not in str(event.call_args)
    assert "session-1" not in str(event.call_args)


def test_governed_recap_rejects_payload_for_another_thread(governed):
    _, _, path = governed
    path.write_text(json.dumps({"session_id": "session-1", "thread_id": "other-thread"}))
    assert sophia._read_session_recap("owner-1", "session-1") is None


def test_recap_cleanup_is_rollout_scoped(governed, monkeypatch):
    _, record, path = governed
    client, _ = _delete_client(monkeypatch, record)
    monkeypatch.setenv("SOPHIA_MEMORY_COHORT_PRINCIPALS", "different-owner")
    assert client.delete("/api/v1/sessions/session-1?user_id=owner-1").status_code == 200
    assert path.exists()


@pytest.mark.parametrize("stamp", [None, ["session-1", "thread-1", 1]])
def test_unversioned_or_stale_recap_is_not_current_authority(governed, stamp):
    _, _, path = governed
    payload = json.loads(path.read_text())
    payload["_memory_source_revision"] = stamp
    path.write_text(json.dumps(payload))
    assert sophia._read_session_recap("owner-1", "session-1") is None


def test_governed_writer_stamps_canonical_revision_not_caller_value(governed):
    _, _, path = governed
    sophia._write_session_recap("owner-1", "session-1", {"session_id": "session-1", "thread_id": "thread-1", "_memory_source_revision": ["forged"]})
    assert json.loads(path.read_text())["_memory_source_revision"] == ["session-1", "thread-1", 2]


@pytest.mark.parametrize("state", ["live", "missing", "wrong-owner", "outage", "deleted-during-write"])
def test_offline_recap_writer_uses_same_canonical_fence(governed, monkeypatch, tmp_path, state):
    from deerflow.sophia import offline_pipeline, session_store

    store, record, path = governed
    path.unlink()
    monkeypatch.setattr(offline_pipeline, "USERS_DIR", tmp_path)
    monkeypatch.setattr(session_store, "SessionStore", lambda: store)
    if state == "missing":
        store.get.return_value = None
    elif state == "wrong-owner":
        store.get.return_value = record.model_copy(update={"user_id": "other-owner"})
    elif state == "outage":
        store.get.side_effect = RuntimeError("unavailable")
    elif state == "deleted-during-write":
        store.get.side_effect = [record, record, None]
    if state == "live":
        assert offline_pipeline._write_offline_recap("owner-1", "session-1", "thread-1", {}, 2) == "ok"
        assert json.loads(path.read_text())["_memory_source_revision"] == ["session-1", "thread-1", 2]
    else:
        with pytest.raises(OSError, match="recap_source_unavailable"):
            offline_pipeline._write_offline_recap("owner-1", "session-1", "thread-1", {}, 2)
        assert not path.exists()
