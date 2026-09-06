// Disposable PostgreSQL regression; no production connection or credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const postgresVersion = (await db.query('show server_version')).rows[0].server_version;
const repository = new URL('../', import.meta.url);
const original = readFileSync(new URL('backend/migrations/2026_08_23_voice_lab_cleanup_obligation_indexes.sql', repository), 'utf8');
const start = original.indexOf('create or replace function public.sophia_voice_lab_message_write_fence()');
assert(start >= 0);
const finish = original.indexOf('\n$$;', start) + 4;
const fence = original.slice(start, finish);
const body = fence.slice(fence.indexOf('as $$') + 5, fence.lastIndexOf('$$;'));
assert.equal(createHash('sha256').update(body).digest('hex'), '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.sophia_sessions (id text primary key, user_id text not null, thread_id text not null, metadata jsonb not null default '{}');
    create table public.sophia_session_messages (id text primary key, session_id text not null references public.sophia_sessions(id) on delete cascade, user_id text not null, thread_id text not null);
    create table public.sophia_voice_lab_cleanup_obligations (cleanup_obligation_id text primary key, state text, lifecycle_phase text, retention_expires_at timestamptz, provider_expires_at timestamptz);
    create table public.sophia_voice_lab_cleanup_admissions (cleanup_obligation_id text);
    insert into public.sophia_sessions values ('ordinary-a','owner-a','thread-a','{}'),('ordinary-b','owner-b','thread-b','{}');
    insert into public.sophia_session_messages values ('message-a','ordinary-a','owner-a','thread-a'),('message-b','ordinary-b','owner-b','thread-b');
  `);
  await db.exec(fence);
  await db.exec('create trigger sophia_voice_lab_message_write_fence before insert or update or delete on public.sophia_session_messages for each row execute function public.sophia_voice_lab_message_write_fence();');
  if (process.argv.includes('--repair')) {
    const migration = readFileSync(new URL('backend/migrations/2026_09_06_mem00_ordinary_session_delete_order.sql', repository), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
  }
  // Baseline RED reproduces the exact hosted error, not a mocked store outcome.
  await db.exec("delete from public.sophia_sessions where id='ordinary-a' and user_id='owner-a';");
  assert.equal((await db.query("select count(*)::int n from public.sophia_session_messages where session_id='ordinary-a'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int n from public.sophia_session_messages where session_id='ordinary-b'")).rows[0].n, 1);

  await db.exec("begin; delete from public.sophia_sessions where id='ordinary-b' and user_id='owner-b'; rollback;");
  assert.equal((await db.query("select count(*)::int n from public.sophia_sessions where id='ordinary-b'")).rows[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from public.sophia_session_messages where session_id='ordinary-b'")).rows[0].n, 1);

  await db.exec(`
    insert into public.sophia_voice_lab_cleanup_obligations values ('11111111-1111-4111-8111-111111111111','open','session_provisional',now()+interval '1 day',now()+interval '2 days');
    insert into public.sophia_sessions values ('governed','voice-owner','voice-thread',jsonb_build_object('synthetic_voice_lab',jsonb_build_object('synthetic',true,'cleanup_obligation_id','11111111-1111-4111-8111-111111111111','retention_expires_at',now()+interval '1 day','provider_expires_at',now()+interval '2 days')));
    insert into public.sophia_session_messages values ('governed-message','governed','voice-owner','voice-thread');
  `);
  await assert.rejects(db.exec("delete from public.sophia_sessions where id='governed'"), /synthetic transcript parent session is unavailable/);
  await assert.rejects(db.exec("delete from public.sophia_session_messages where id='governed-message'"), /synthetic transcript retention deletion is unavailable/);
  assert.equal((await db.query("select count(*)::int n from public.sophia_session_messages where session_id='governed'")).rows[0].n, 1);
  const pin = await db.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') hash from pg_proc where proname='sophia_voice_lab_message_write_fence'");
  assert.equal(pin.rows[0].hash, '11adcf09844e96acbdc00e76bd9d6504a9a834540a3d30774e09a45b15a032f3');
  const acl = await db.query("select has_function_privilege('anon','public.sophia_mem00_ordinary_session_delete_order()','execute') anon, has_function_privilege('authenticated','public.sophia_mem00_ordinary_session_delete_order()','execute') authenticated");
  assert.equal(acl.rows[0].anon, false);
  assert.equal(acl.rows[0].authenticated, false);
  await db.exec("insert into public.sophia_session_messages values ('foreign-child','ordinary-b','other-owner','thread-b')");
  await assert.rejects(db.exec("delete from public.sophia_sessions where id='ordinary-b'"), /synthetic transcript parent session is unavailable/);
  assert.equal((await db.query("select count(*)::int n from public.sophia_session_messages where session_id='ordinary-b'")).rows[0].n, 2);
  assert.equal((await db.query("select count(*)::int n from public.sophia_sessions where id='ordinary-b'")).rows[0].n, 1);
  await db.exec("drop trigger sophia_mem00_ordinary_session_delete_order on public.sophia_sessions; drop function public.sophia_mem00_ordinary_session_delete_order();");
  await assert.rejects(db.exec("delete from public.sophia_sessions where id='ordinary-b'"), /synthetic transcript parent session is unavailable/);
  console.log(JSON.stringify({status:'passed',postgres_version:postgresVersion,ordinary_cascade:true,wrong_owner_untouched:true,foreign_child_conflict_rolls_back:true,browser_function_execution_denied:true,rollback_restores_parent_and_child:true,synthetic_parent_delete_denied:true,synthetic_child_delete_denied:true,message_fence_unchanged:true,applied_twice:true,ddl_rollback_restores_prior_behavior:true,external_mutations:0}));
} catch (error) {
  console.log(JSON.stringify({status:'failed',safe_reason:error.message === 'synthetic transcript parent session is unavailable' ? 'synthetic_parent_unavailable_during_ordinary_cascade' : 'contract_assertion_failed',external_mutations:0}));
  process.exitCode = 1;
} finally {
  await db.close();
}
