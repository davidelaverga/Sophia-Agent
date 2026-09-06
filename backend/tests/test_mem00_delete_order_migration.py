"""Guard the additive ordinary-delete ordering repair; PostgreSQL proof is separate."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).parents[1]
MIGRATION = ROOT / "migrations/2026_09_06_mem00_ordinary_session_delete_order.sql"


def test_delete_order_function_is_pinned_and_transactional():
    sql = MIGRATION.read_text()
    body = sql.split("as $function$")[1].split("$function$;")[0]
    assert hashlib.sha256(body.encode()).hexdigest() in sql
    assert "begin;" in sql and sql.rstrip().endswith("commit;")
    assert "11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3" in sql
    assert "ordinary delete message fence contract drifted" in sql


def test_delete_order_does_not_replace_or_disable_synthetic_fences():
    sql = MIGRATION.read_text().lower()
    assert "create or replace function public.sophia_voice_lab" not in sql
    assert "disable trigger" not in sql
    assert "if coalesce(old.metadata -> 'synthetic_voice_lab' ->> 'synthetic' = 'true', false) then" in sql
    assert sql.index("return old;") < sql.index("delete from public.sophia_session_messages")


def test_delete_order_is_exact_owner_scoped_and_before_parent_deletion():
    sql = MIGRATION.read_text().lower()
    assert "where session_id = old.id and user_id = old.user_id" in sql
    assert "before delete on public.sophia_sessions" in sql
    assert "set search_path = pg_catalog, public" in sql
    assert "from public, anon, authenticated" in sql
