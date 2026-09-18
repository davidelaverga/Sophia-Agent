// Existing disposable PostgreSQL runtime only; no network or production credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url);
const base = readFileSync(new URL('backend/migrations/2026_09_02_mem00_durable_memory_governance.sql', root), 'utf8');
const migration = readFileSync(new URL('backend/migrations/2026_09_08_mem00_c1_owner_authority.sql', root), 'utf8');
const db = new PGlite();
let checks = 0;
const one = async (sql, params=[]) => (await db.query(sql, params)).rows[0];
const denied = async (sql, pattern) => { await assert.rejects(db.exec(sql), pattern); checks++; };
const declare = async (owner, expected, target, ref) => (await one(
  'select public.sophia_memory_declare_owner_authority($1,$2,$3,1,$4) receipt', [owner,expected,target,ref])).receipt;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.sophia_sessions(id text primary key,user_id text,thread_id text,message_revision bigint,memory_processed_until_sequence bigint,status text,ended_at timestamptz,updated_at timestamptz);
    create table public.sophia_session_messages(id text,session_id text,user_id text,sequence bigint,role text,content text,final boolean);`);
  await db.exec(base);
  const original = await one("select (public.sophia_memory_ensure_governance('synthetic-existing')).provider_subject");
  await one(`select public.sophia_memory_manual_create('synthetic-history','SYNTHETIC-OLD','hmac-sha256:synthetic:old-content','fact','global','none','user','synthetic-old-create','synthetic-old-digest','mem0','synthetic','existing-project') receipt`);
  await db.exec(migration);
  await db.exec(migration);
  const upgraded = await one("select * from public.sophia_memory_user_governance where user_id='synthetic-existing'");
  assert.equal(upgraded.authority_state,'unknown');
  assert.equal(upgraded.provider_subject,original.provider_subject);
  checks += 2;
  await denied("select public.sophia_memory_ensure_governance('synthetic-existing')", /memory_owner_authority_required/);
  await denied("select public.sophia_memory_ensure_governance('synthetic-absent')", /memory_owner_authority_required/);
  assert.equal((await one("select count(*)::int n from public.sophia_memory_user_governance where user_id='synthetic-absent'")).n,0); checks++;
  await denied(`select public.sophia_memory_record_prompt_admission(gen_random_uuid(),'synthetic-existing',
    'synthetic','global','hmac-sha256:synthetic:query','mem0','synthetic','existing-project','namespace',
    'ok',0,0,0,'[]','{}','authorized',null,'{}')`, /memory_owner_authority_required/);
  await denied("select public.sophia_memory_declare_owner_authority('synthetic-history','unknown','legacy',1,'hmac-sha256:synthetic:history-approval')", /memory_owner_has_canonical_history/);
  const legacy = await declare('synthetic-existing','unknown','legacy','hmac-sha256:synthetic:legacy-approval');
  const governed = await declare('synthetic-existing','legacy','governed','hmac-sha256:synthetic:cutover-approval');
  assert.deepEqual(await declare('synthetic-existing','unknown','legacy','hmac-sha256:synthetic:legacy-approval'),legacy);
  assert.deepEqual(await declare('synthetic-existing','legacy','governed','hmac-sha256:synthetic:cutover-approval'),governed);
  assert.equal((await one("select (public.sophia_memory_ensure_governance('synthetic-existing')).authority_state")).authority_state,'governed'); checks+=3;
  await denied("update public.sophia_memory_user_governance set authority_state='legacy' where user_id='synthetic-existing'",/memory_owner_authority_rollback_denied/);
  await denied("delete from public.sophia_memory_user_governance where user_id='synthetic-existing'",/memory_owner_authority_is_durable/);
  await denied("truncate public.sophia_memory_user_governance cascade",/memory_owner_authority_is_durable/);
  await denied("update public.sophia_memory_user_governance set authority_epoch=0 where user_id='synthetic-existing'",/memory_owner_authority_rollback_denied/);
  await denied("update public.sophia_memory_user_governance set authority_receipts='[]' where user_id='synthetic-existing'",/memory_owner_authority_rollback_denied/);
  await denied("select public.sophia_memory_declare_owner_authority('synthetic-existing','legacy','legacy',1,'hmac-sha256:synthetic:cutover-approval')",/memory_owner_declaration_conflict/);
  await denied("select public.sophia_memory_declare_owner_authority('synthetic-new','unknown','governed',2,'hmac-sha256:synthetic:bad-epoch-approval')",/memory_owner_contract_incompatible/);
  assert.equal((await one("select count(*)::int n from public.sophia_memory_user_governance where user_id='synthetic-new'")).n,0); checks++;
  await db.exec('set role service_role');
  const saved = await one(`select public.sophia_memory_manual_create('synthetic-existing','SYNTHETIC-CANONICAL','hmac-sha256:synthetic:content','fact','global','none','user','synthetic-create','synthetic-digest','mem0','synthetic','existing-project') receipt`);
  assert(saved.receipt.memory_id); checks++;
  // The existing canonical transaction still runs under app privilege; enrollment does not.
  await denied("select public.sophia_memory_declare_owner_authority('synthetic-unapproved','unknown','governed',1,'hmac-sha256:synthetic:unapproved')",/permission denied/);
  await denied("update public.sophia_memory_user_governance set authority_state='legacy'",/permission denied/);
  const clock = await one("select (public.sophia_memory_ensure_governance('synthetic-existing')).user_catalog_generation generation");
  assert.equal(Number(clock.generation),1); checks++;
  const admission = await one(`select public.sophia_memory_record_prompt_admission(gen_random_uuid(),'synthetic-existing',
    'synthetic','global','hmac-sha256:synthetic:query','mem0','synthetic','existing-project','namespace',
    'ok',0,1,0,'[]','{}','authorized',null,'{}') id`);
  assert(admission.id); checks++;
  await denied(`insert into public.sophia_memory_prompt_admissions(retrieval_request_id,user_id,caller,scope,query_ref,provider_status,
    catalog_generation_checked,revocation_epoch_checked,outcome) values(gen_random_uuid(),'synthetic-history','synthetic','global',
    'hmac-sha256:synthetic:query','ok',1,0,'authorized')`, /memory_owner_authority_required/);
  await db.exec('reset role');
  await declare('synthetic-legacy','unknown','legacy','hmac-sha256:synthetic:legacy-fixture');
  await denied(`select public.sophia_memory_record_prompt_admission(gen_random_uuid(),'synthetic-legacy',
    'synthetic','global','hmac-sha256:synthetic:query','mem0','synthetic','existing-project','namespace',
    'ok',0,0,0,'[]','{}','authorized',null,'{}')`, /memory_owner_authority_required/);
  await db.exec(migration);
  assert.equal((await one("select authority_state from public.sophia_memory_user_governance where user_id='synthetic-existing'")).authority_state,'governed'); checks++;
  await db.exec("begin; select public.sophia_memory_declare_owner_authority('synthetic-rollback','unknown','governed',1,'hmac-sha256:synthetic:rollback-approval'); rollback;");
  assert.equal((await one("select count(*)::int n from public.sophia_memory_user_governance where user_id='synthetic-rollback'")).n,0); checks++;
  let composed = null;
  if (process.argv[3]) {
    const payload = {
      contract: await one('select * from public.sophia_memory_contract where singleton'),
      owners: (await db.query('select user_id,authority_state,authority_epoch,authority_declared_at from public.sophia_memory_user_governance')).rows,
    };
    const result = spawnSync(process.argv[3], ['run','python','../tools/mem00_owner_authority_composed.py'], {
      cwd: new URL('backend/',root), input: JSON.stringify(payload), encoding:'utf8', timeout:30000,
      env:{...process.env,PYTHONPATH:'.'},
    });
    assert.equal(result.status,0,result.stderr);
    composed = JSON.parse(result.stdout);
    assert.equal(composed.passed,true); checks++;
  }
  console.log(JSON.stringify({schema:'mem00.c1-owner-authority-sql.v1',passed:true,checks,postgres:(await one('show server_version')).server_version,
    migration_sha256:createHash('sha256').update(migration).digest('hex'),composed,production_mutations:0,cleanup:'entire disposable database closed',
    scope:'DDL replay, upgrade preservation, explicit declarations, replay receipts, downgrade/delete/truncate fence, canonical RPC and least privilege; no independent multi-process concurrency or deployed routing proof'}));
} finally { await db.close(); }
