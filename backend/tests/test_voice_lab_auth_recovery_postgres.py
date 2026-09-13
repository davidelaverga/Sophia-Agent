"""Run only through the frontend product-migration integration fixture."""

import json
import os
from urllib.parse import urlsplit, urlunsplit

import pytest
from test_voice_lab_recovery import AUTH_TOMBSTONE_SECRET, _claims, _session_marker

from app.gateway.routers import voice_lab_recovery as recovery


@pytest.mark.skipif(
    os.getenv("SOPHIA_VOICE_LAB_PRODUCT_AUTH_FIXTURE_READY") != "YES",
    reason="requires migrated, dedicated product PostgreSQL fixture",
)
def test_exact_auth_cleanup_with_pending_provider(monkeypatch):
    import psycopg

    dsn = os.environ["SOPHIA_VOICE_LAB_TEST_DATABASE_URL"]
    parsed = urlsplit(dsn)
    assert parsed.hostname in {"127.0.0.1", "localhost"}
    assert parsed.path == "/voice_lab_test"
    assert os.environ.get("SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED") == "YES"
    runtime_dsn = urlunsplit(parsed._replace(netloc=f"better_auth_app@{parsed.hostname}:{parsed.port}"))
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_DATABASE_URL", runtime_dsn)
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_ACTIVE_KID", "v1")
    monkeypatch.setenv("SOPHIA_VOICE_LAB_AUTH_TOMBSTONE_KEYS", json.dumps({"v1": AUTH_TOMBSTONE_SECRET}))
    claims = _claims()
    marker, row = _session_marker(run_id=claims.test_run_id, token="exact-test-token")
    other_id = "923e4567-e89b-42d3-a456-426614174000"
    admission_id = "823e4567-e89b-42d3-a456-426614174000"
    with psycopg.connect(dsn) as db:
        with db.cursor() as cur:
            cur.execute('INSERT INTO public."session" (id, "userId", token, "expiresAt", "userAgent") VALUES (%s,%s,%s,%s,%s)', ("exact-test", claims.principal_id, "exact-test-token", row[5], marker))
            cur.execute('INSERT INTO public."session" (id, "userId", token, "expiresAt", "userAgent") VALUES (%s,%s,%s,%s,%s)', ("ordinary-test", claims.principal_id, "ordinary-test-token", row[5], "ordinary-browser"))
            cur.execute('INSERT INTO public."session" (id, "userId", token, "expiresAt") VALUES (%s,%s,%s,%s)', ("unrelated-test", "unrelated-principal", "unrelated-token", row[5]))
            for cleanup_id in (claims.cleanup_obligation_id, other_id):
                cur.execute("INSERT INTO public.sophia_voice_lab_cleanup_obligations (cleanup_obligation_id, retention_expires_at, provider_expires_at) VALUES (%s,%s,%s)", (cleanup_id, row[5], row[5]))
            cur.execute(
                """INSERT INTO public.sophia_voice_lab_auth_grants
                (grant_fingerprint,principal_id,test_run_id,tombstone_kid,cleanup_obligation_id,
                 issued_at,expires_at,provider_expires_at,retention_hours,jti_sha256,nonce_sha256,session_token_sha256,status)
                VALUES (%s,%s,%s,'v1',%s,%s,now()-interval '1 hour',%s,24,%s,%s,%s,'active')""",
                (row[0], claims.principal_id, claims.test_run_id, claims.cleanup_obligation_id, row[4], row[5], row[7], row[8], row[9]),
            )
            cur.execute(
                """INSERT INTO public.sophia_voice_lab_auth_grants
                (grant_fingerprint,principal_id,test_run_id,tombstone_kid,cleanup_obligation_id,
                 issued_at,expires_at,provider_expires_at,retention_hours,jti_sha256,nonce_sha256,session_token_sha256,status)
                VALUES (repeat('9',64),'unrelated-principal','unrelated-run','v1',%s,1,
                now()-interval '1 hour',%s,24,repeat('2',64),repeat('3',64),
                encode(sha256(convert_to('unrelated-token','UTF8')),'hex'),'active')""",
                (other_id, row[5]),
            )
            cur.execute(
                """INSERT INTO public.sophia_voice_lab_cleanup_admissions
                (admission_id,cleanup_obligation_id,resource_kind,resource_id,status,lease_expires_at,resource_expires_at)
                VALUES (%s,%s,'provider','pending-provider','browser_active',now()+interval '1 minute',%s)""",
                (admission_id, claims.cleanup_obligation_id, row[5]),
            )
            cur.execute("UPDATE public.sophia_voice_lab_cleanup_obligations SET state='closed',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE cleanup_obligation_id=ANY(%s)", ([claims.cleanup_obligation_id, other_id],))
            cur.execute(
                """UPDATE public.sophia_voice_lab_auth_grants SET status='revoked',revoked_at=now(),
                principal_id=%s,test_run_id=%s,cleanup_obligation_id=%s,jti_sha256=repeat('0',64),
                nonce_sha256=repeat('0',64),session_token_sha256=repeat('0',64)
                WHERE grant_fingerprint=repeat('9',64)""",
                tuple(recovery._auth_tombstone_identity(kind, value, kid="v1") for kind, value in (("principal", "unrelated-principal"), ("run", "unrelated-run"), ("cleanup", other_id))),
            )
            cur.execute("SELECT row_to_json(g) FROM public.sophia_voice_lab_auth_grants g WHERE grant_fingerprint=repeat('9',64)")
            unrelated_before = cur.fetchone()[0]
    result = recovery._recover_auth_sessions_sync(claims)
    assert result["status"] == "completed", result
    assert result["sessions_revoked"] == 1
    assert result["grants_tombstoned"] == 1
    assert result["ordinary_sessions_preserved"] == 1
    repeated = recovery._recover_auth_sessions_sync(claims)
    assert repeated["status"] == "already_terminal", repeated
    assert repeated["sessions_revoked"] == 0
    assert repeated["grants_tombstoned"] == 0
    with psycopg.connect(dsn) as db:
        with db.cursor() as cur:
            cur.execute("SELECT row_to_json(g) FROM public.sophia_voice_lab_auth_grants g WHERE grant_fingerprint=repeat('9',64)")
            assert cur.fetchone()[0] == unrelated_before
            cur.execute("SELECT count(*) FROM public.sophia_voice_lab_auth_grants WHERE grant_fingerprint=%s", (row[0],))
            assert cur.fetchone()[0] == 0
            cur.execute('SELECT id FROM public."session" WHERE "userId"=%s', (claims.principal_id,))
            assert cur.fetchall() == [("ordinary-test",)]
            cur.execute("SELECT status FROM public.sophia_voice_lab_cleanup_admissions WHERE admission_id=%s", (admission_id,))
            assert cur.fetchone() == ("browser_active",)
            cur.execute("SELECT state,live_cleanup_completed_at,provider_settlement_sha256 FROM public.sophia_voice_lab_cleanup_obligations WHERE cleanup_obligation_id=%s", (claims.cleanup_obligation_id,))
            assert cur.fetchone() == ("closed", None, None)
