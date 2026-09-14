"""Exercise the production SQL branch, not the permissive in-memory adapter."""

import json
from datetime import UTC, datetime, timedelta

import pytest

from deerflow.sophia import cleanup_fence


class Cursor:
    def __init__(self, row):
        self.row = row
        self.rowcount = 1
        self.writes = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params):
        if sql.strip().startswith("UPDATE"):
            self.writes.append((sql, params))

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, cursor):
        self.cur = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cur


@pytest.mark.parametrize("case", ["continuation", "first", "replay", "wrong_pending", "wrong_epoch", "unstaged", "wrong_state", "wrong_identity", "closed", "expired", "provider_expired"])
def test_sql_activation_requires_exact_staged_epoch(monkeypatch, case):
    now = datetime.now(UTC)
    cleanup_id = "123e4567-e89b-42d3-a456-426614174000"
    admission = cleanup_fence.CleanupAdmission(
        admission_id="123e4567-e89b-42d3-a456-426614174001",
        cleanup_obligation_id=cleanup_id,
        resource_kind="provider",
        resource_id="provider-c5",
        lease_expires_at=now + timedelta(seconds=120),
        resource_expires_at=now + timedelta(minutes=30),
        status="browser_active",
    )
    current = {
        "cleanup_obligation_id": cleanup_id,
        "cleanup_provider_admission_id": admission.admission_id,
        "voice_runtime_session_id": admission.resource_id,
        "voice_provider_resource_state": "active",
        "voice_provider_connection_epoch": 1,
        "voice_provider_pending_connection_epoch": 2,
        "voice_provider_activation_receipt": {"candidate_epoch": 1},
    }
    desired_epoch = 2
    status = "browser_active"
    if case == "first":
        current.update(voice_provider_resource_state="credential_minted", voice_provider_connection_epoch=None, voice_provider_pending_connection_epoch=1)
        status, desired_epoch = "credential_minted", 1
    elif case == "replay":
        current.update(voice_provider_connection_epoch=2, voice_provider_pending_connection_epoch=None, voice_provider_activation_receipt={"candidate_epoch": 2})
    elif case == "wrong_pending":
        current["voice_provider_pending_connection_epoch"] = 3
    elif case == "wrong_epoch":
        current["voice_provider_connection_epoch"] = 0
    elif case == "unstaged":
        current["voice_provider_pending_connection_epoch"] = None
    elif case == "wrong_state":
        current["voice_provider_resource_state"] = "closed"
    elif case == "wrong_identity":
        current["voice_runtime_session_id"] = "another-provider"
    desired = dict(current, voice_provider_connection_epoch=desired_epoch, voice_provider_pending_connection_epoch=None, voice_provider_resource_state="active", voice_provider_activation_receipt={"candidate_epoch": desired_epoch})
    row = ("closed" if case == "closed" else "open", status, admission.lease_expires_at, admission.resource_expires_at, case != "expired", case != "provider_expired", current)
    cursor = Cursor(row)
    monkeypatch.setattr(cleanup_fence, "_connect", lambda: Connection(cursor))
    args = dict(user_id="test-principal", session_id="test-session", metadata={"synthetic_voice_lab": desired}, expected_synthetic=current, local_persist=lambda *_: pytest.fail("must use SQL path"))
    if case in {"continuation", "first", "replay"}:
        result = cleanup_fence.activate_cleanup_provider_session(admission, **args)
        assert result.status == "browser_active"
        assert len(cursor.writes) == 2
        persisted = json.loads(cursor.writes[1][1][0])
        assert persisted["voice_provider_connection_epoch"] == desired_epoch
        assert persisted["voice_provider_pending_connection_epoch"] is None
    else:
        with pytest.raises(cleanup_fence.CleanupFenceError):
            cleanup_fence.activate_cleanup_provider_session(admission, **args)
        assert cursor.writes == []
