"""Disposable PostgreSQL integration, invoked by the product migration fixture."""
import copy
import json
import os
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from urllib.parse import urlsplit, urlunsplit

import pytest
from deerflow.sophia import cleanup_fence
from test_voice_lab_process_termination import bound, receipt_for  # noqa: F401
from app.gateway import voice_lab_process_termination as process


@pytest.mark.skipif(os.getenv("SOPHIA_VOICE_LAB_PRODUCT_AUTH_FIXTURE_READY") != "YES",
    reason="requires migrated disposable product PostgreSQL")
def test_process_termination_atomic_database_binding_and_owner_ack(bound, monkeypatch):
    import psycopg
    # The shared fixture mocks the public symbol; recover the real implementation
    # through the unmodified imported alias used by its local atomic regression.
    from test_voice_lab_process_termination import atomic_close
    claims, record, _, commit = bound
    process.accept_browser_process_termination(claims, record, receipt_for(claims))
    kwargs = copy.deepcopy({key: value for key, value in commit.call_args.kwargs.items() if key != "local_persist"})
    kwargs["local_persist"] = Mock(side_effect=AssertionError("PostgreSQL must not use local persistence"))
    dsn = os.environ["SOPHIA_VOICE_LAB_TEST_DATABASE_URL"]
    parsed = urlsplit(dsn)
    assert parsed.hostname in {"127.0.0.1", "localhost"} and parsed.path == "/voice_lab_test"
    assert os.environ.get("SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED") == "YES"
    runtime = urlunsplit(parsed._replace(netloc=f"better_auth_app@{parsed.hostname}:{parsed.port}"))
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", runtime)
    cleanup_id = "993e4567-e89b-42d3-a456-426614174000"
    admission_id = "983e4567-e89b-42d3-a456-426614174000"
    now = datetime.now(UTC).replace(microsecond=0)
    retention = now + timedelta(hours=24)
    provider = now + timedelta(minutes=20)
    lease = now + timedelta(minutes=1)
    text = lambda value: value.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    desired = kwargs["metadata"]["synthetic_voice_lab"]
    desired.update(cleanup_obligation_id=cleanup_id, cleanup_provider_admission_id=admission_id,
        retention_expires_at=text(retention), provider_expires_at=text(provider),
        voice_provider_resource_expires_at=text(provider))
    receipt = dict(desired["voice_provider_browser_close_receipts"][0])
    receipt["cleanup_obligation_id_sha256"] = process._text_digest(cleanup_id)
    receipt["receipt_sha256"] = process._digest({key: value for key, value in receipt.items() if key != "receipt_sha256"})
    desired["voice_provider_browser_close_receipts"] = [receipt]
    kwargs["settlement_sha256"] = process.browser_process_settlement_digest(receipt)
    before = copy.deepcopy(kwargs["metadata"])
    before["synthetic_voice_lab"].update(voice_provider_resource_state="active")
    before["synthetic_voice_lab"]["voice_provider_browser_close_receipts"] = []
    kwargs.update(retention_expires_at=text(retention), provider_expires_at=text(provider))
    admission = cleanup_fence.CleanupAdmission(admission_id=admission_id, cleanup_obligation_id=cleanup_id,
        resource_kind="provider", resource_id="provider-test", lease_expires_at=lease,
        resource_expires_at=provider, status="browser_active")
    with psycopg.connect(dsn) as db:
        db.execute("INSERT INTO public.sophia_voice_lab_cleanup_obligations (cleanup_obligation_id,lifecycle_phase,retention_expires_at,provider_expires_at) VALUES (%s,'session_provisional',%s,%s)", (cleanup_id,retention,provider))
        db.execute("INSERT INTO public.sophia_voice_lab_cleanup_admissions (admission_id,cleanup_obligation_id,resource_kind,resource_id,status,lease_expires_at,resource_expires_at) VALUES (%s,%s,'provider','provider-test','browser_active',%s,%s)", (admission_id,cleanup_id,lease,provider))
        # Seed the already-created session as the fixture owner; restore every
        # trigger before exercising the restricted runtime atomic transition.
        db.execute("SET LOCAL session_replication_role = replica")
        db.execute("INSERT INTO public.sophia_sessions (id,user_id,thread_id,run_id,metadata,created_at) VALUES (%s,%s,'thread-test',%s,%s::jsonb,%s)", (record.session_id,record.user_id,claims.test_run_id,json.dumps(before),now))
        db.execute("SET LOCAL session_replication_role = origin")
    with pytest.raises(cleanup_fence.CleanupFenceError, match="unavailable"):
        atomic_close(admission, **kwargs)
    with psycopg.connect(dsn) as db:
        db.execute("UPDATE public.sophia_voice_lab_cleanup_obligations SET state='closed',closed_at=now() WHERE cleanup_obligation_id=%s", (cleanup_id,))
    wrong = {**kwargs, "expected_activated_epoch": 3}
    with pytest.raises(cleanup_fence.CleanupFenceError, match="conflicts"):
        atomic_close(admission, **wrong)
    with psycopg.connect(dsn) as db:
        assert db.execute("SELECT status FROM public.sophia_voice_lab_cleanup_admissions WHERE admission_id=%s", (admission_id,)).fetchone()[0] == "browser_active"
        assert db.execute("SELECT provider_settlement_sha256 FROM public.sophia_voice_lab_cleanup_obligations WHERE cleanup_obligation_id=%s", (cleanup_id,)).fetchone()[0] is None
    assert atomic_close(admission, **kwargs).status == "browser_closed"
    with psycopg.connect(dsn) as db:
        stored = db.execute("SELECT metadata FROM public.sophia_sessions WHERE id=%s", (record.session_id,)).fetchone()[0]
        assert stored["synthetic_voice_lab"]["voice_provider_browser_close_receipts"] == [receipt]
        assert db.execute("SELECT live_cleanup_completed_at FROM public.sophia_voice_lab_cleanup_obligations WHERE cleanup_obligation_id=%s", (cleanup_id,)).fetchone()[0] is None
        assert db.execute("SELECT status FROM public.sophia_voice_lab_cleanup_admissions WHERE admission_id=%s", (admission_id,)).fetchone()[0] == "browser_closed"
    kwargs["local_persist"].assert_not_called()
