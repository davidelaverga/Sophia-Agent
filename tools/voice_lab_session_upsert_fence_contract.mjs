// Disposable PostgreSQL contract (C051/C052): why a synthetic session metadata
// write failed with P0001 "synthetic cleanup obligation admission is closed"
// while its cleanup obligation was still OPEN. No production connection.
//
// Usage: node tools/voice_lab_session_upsert_fence_contract.mjs <pg module path> <postgres url>
// The host must be loopback and the database name start with voice_lab_; the script
// resets only its own tables in that database.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require(process.argv[2]);
const url = new URL(process.argv[3] ?? '');
assert(/^\/voice_lab_[a-z0-9_]+$/.test(url.pathname), 'disposable voice_lab_* database required');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'loopback PostgreSQL host required');

const migration = readFileSync(new URL('../backend/migrations/2026_08_23_voice_lab_cleanup_obligation_indexes.sql', import.meta.url), 'utf8');
const start = migration.indexOf('create or replace function public.sophia_voice_lab_cleanup_write_fence()');
assert(start >= 0, 'write fence function present');
const fence = migration.slice(start, migration.indexOf('\n$$;', start) + 4);
const body = fence.slice(fence.indexOf('as $$') + 5, fence.lastIndexOf('$$;'));
const FENCE_BODY_SHA256 = "4faacbb98b20ee4e955ae8343e55c163060f9963104c384dadb1263249d28fad";
const bodySha256 = createHash('sha256').update(body).digest('hex');
assert.equal(bodySha256, FENCE_BODY_SHA256, 'exact deployed fence body');

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
const cleanup = '11111111-1111-4111-8111-111111111111';
try {
  const version = (await client.query('show server_version')).rows[0].server_version;
  await client.query(`
    drop table if exists public.sophia_sessions, public.sophia_voice_lab_cleanup_obligations,
      public.sophia_voice_lab_auth_grants, public.sophia_voice_lab_cleanup_admissions cascade;
    drop function if exists public.sophia_voice_lab_cleanup_write_fence() cascade;
    create table public.sophia_voice_lab_cleanup_obligations (cleanup_obligation_id text primary key, state text not null,
      lifecycle_phase text not null, retention_expires_at timestamptz not null, provider_expires_at timestamptz not null,
      provider_settlement_sha256 text);
    create table public.sophia_voice_lab_auth_grants (grant_fingerprint bpchar(64), principal_id text, test_run_id text,
      tombstone_kid text, cleanup_obligation_id text, issued_at bigint, expires_at timestamptz, provider_expires_at timestamptz,
      retention_hours integer, jti_sha256 bpchar(64), nonce_sha256 bpchar(64), session_token_sha256 bpchar(64), status text,
      revoked_at timestamptz);
    create table public.sophia_voice_lab_cleanup_admissions (cleanup_obligation_id text);
    create table public.sophia_sessions (id text primary key, user_id text not null, run_id text, thread_id text not null,
      status text not null, ended_at timestamptz, metadata jsonb not null default '{}', message_count integer not null default 0,
      message_revision bigint not null default 0, transcript_available boolean not null default false, title text,
      last_message_preview text, last_message_at timestamptz, updated_at timestamptz);
  `);
  // An ACTIVE synthetic session: creation already happened (auth_provisional
  // window), so the obligation is open and session_provisional.
  await client.query(`insert into public.sophia_voice_lab_cleanup_obligations
    values ($1, 'open', 'session_provisional', date_trunc('milliseconds', now() + interval '1 day'),
      date_trunc('milliseconds', now() + interval '30 minutes'), null)`, [cleanup]);
  const { rows: [obligation] } = await client.query('select retention_expires_at, provider_expires_at from public.sophia_voice_lab_cleanup_obligations');
  const metadata = { synthetic_voice_lab: { synthetic: true, principal_id: 'vt00-principal', test_run_id: 'run-c052', cleanup_obligation_id: cleanup,
    scenario_id: 'V-O01', scenario_version: 'v1', environment: 'production', retention_hours: 24,
    retention_anchor: 'session_created_at_provisional',
    retention_expires_at: obligation.retention_expires_at.toISOString(), provider_expires_at: obligation.provider_expires_at.toISOString() },
    expected_deployment: { frontend: 'a'.repeat(40), backend: 'a'.repeat(40), voice: 'a'.repeat(40) },
    memory_retrieval_disabled: true, inactivity_finalization_disabled: true, offline_pipeline_disabled: true,
    memory_learning_disabled: true, ordinary_analytics_disabled: true, ordinary_projects_disabled: true, shared_spaces_disabled: true };
  await client.query(`insert into public.sophia_sessions (id, user_id, run_id, thread_id, status, metadata, message_count, message_revision, updated_at)
    values ('sess-c052', 'vt00-principal', 'run-c052', 'thread-c052', 'active', $1, 0, 1, now())`, [metadata]);
  await client.query(fence);
  const installed = (await client.query("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') h from pg_proc where proname='sophia_voice_lab_cleanup_write_fence'")).rows[0].h;
  assert.equal(installed, bodySha256, 'installed function is the extracted migration text');
  await client.query('create trigger sophia_voice_lab_cleanup_write_fence before insert or update or delete on public.sophia_sessions for each row execute function public.sophia_voice_lab_cleanup_write_fence()');

  // 1. The production store's update(): PostgREST merge-duplicates upsert of the
  //    EXISTING row. BEFORE INSERT fires first, the creation branch refuses.
  const upsert = `insert into public.sophia_sessions (id, user_id, run_id, thread_id, status, metadata, message_count, message_revision, title, last_message_preview, updated_at)
    select id, user_id, run_id, thread_id, status, metadata, 2, message_revision, title, null, now() from public.sophia_sessions where id = 'sess-c052'
    on conflict (id) do update set message_count = excluded.message_count, last_message_preview = excluded.last_message_preview,
      title = excluded.title, updated_at = excluded.updated_at`;
  await assert.rejects(client.query(upsert), (error) => error.code === 'P0001' && error.message === 'synthetic cleanup obligation admission is closed');
  const { rows: [afterUpsert] } = await client.query("select message_count from public.sophia_sessions where id = 'sess-c052'");
  assert.equal(afterUpsert.message_count, 0, 'refused upsert changed nothing');
  // ...although the obligation is NOT closed: the wording names the creation window.
  assert.equal((await client.query('select state from public.sophia_voice_lab_cleanup_obligations')).rows[0].state, 'open');

  // 2. The same metadata as a plain UPDATE of the existing row is admitted.
  await client.query("update public.sophia_sessions set message_count = 2, last_message_preview = null, updated_at = now() where id = 'sess-c052'");
  assert.equal((await client.query("select message_count from public.sophia_sessions where id = 'sess-c052'")).rows[0].message_count, 2);

  // 3. The revisioned snapshot write's session update (as inside the RPC) is admitted.
  await client.query("update public.sophia_sessions set message_revision = message_revision + 1, transcript_available = true, updated_at = now() where id = 'sess-c052'");
  assert.equal(Number((await client.query("select message_revision from public.sophia_sessions where id = 'sess-c052'")).rows[0].message_revision), 2);

  // 4. The creation fence itself is intact: a NEW synthetic session cannot be admitted now.
  await assert.rejects(client.query(`insert into public.sophia_sessions (id, user_id, run_id, thread_id, status, metadata)
    values ('sess-c052-second', 'vt00-principal', 'run-c052', 'thread-2', 'active', $1)`, [metadata]),
    (error) => error.code === 'P0001' && error.message === 'synthetic cleanup obligation admission is closed');

  console.log(JSON.stringify({ status: 'passed', postgres_version: version, fence_body_sha256: bodySha256, installed_function_prosrc_sha256: installed,
    upsert_of_existing_row_refused_p0001: true, obligation_state_open: true, plain_update_admitted: true,
    revision_update_admitted: true, new_insert_still_refused: true, external_mutations: 0 }));
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', message: String(error?.message ?? error).slice(0, 200), code: error?.code ?? null, external_mutations: 0 }));
  process.exitCode = 1;
} finally {
  await client.query(`drop table if exists public.sophia_sessions, public.sophia_voice_lab_cleanup_obligations,
    public.sophia_voice_lab_auth_grants, public.sophia_voice_lab_cleanup_admissions cascade;
    drop function if exists public.sophia_voice_lab_cleanup_write_fence() cascade;`).catch(() => undefined);
  await client.end();
}
