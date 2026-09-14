// Disposable SQL contract only; no production credentials, provider or model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const root = new URL('../', import.meta.url);
const db = new PGlite();
let checks = 0;
const one = async (sql, params=[]) => (await db.query(sql, params)).rows[0];
const call = async (name, args) => (await one(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) receipt`,args)).receipt;
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.sophia_sessions(id text primary key,user_id text,thread_id text,message_revision bigint,memory_processed_until_sequence bigint,status text,ended_at timestamptz,updated_at timestamptz);
    create table public.sophia_session_messages(id text,session_id text,user_id text,sequence bigint,role text,content text,final boolean);`);
  for (const name of ['2026_09_02_mem00_durable_memory_governance.sql','2026_09_08_mem00_c1_owner_authority.sql']) {
    await db.exec(readFileSync(new URL('backend/migrations/'+name,root),'utf8'));
  }
  if (process.argv[3]) {
    const repair=readFileSync(new URL('backend/migrations/2026_09_08_mem00_c1_command_receipts.sql',root),'utf8');
    await db.exec(repair); await db.exec(repair);
  }
  await call('sophia_memory_declare_owner_authority',['receipt-owner','unknown','governed',1,'hmac-sha256:synthetic:receipt-approval']);
  const createArgs=['receipt-owner','SYNTHETIC-CONTENT','hmac-sha256:synthetic:content','fact','global','none','user','create-key','create-digest','mem0','synthetic','existing-project'];
  const created=await call('sophia_memory_manual_create',createArgs);
  assert.equal(typeof created.operation_id,'string','canonical receipt lacks the original operation ID'); checks++;
  assert.equal(created.event_type,'memory_manual_created'); checks++;
  assert.equal(created.resulting_lifecycle,'active'); checks++;
  const editArgs=['receipt-owner',created.memory_id,1,1,'SYNTHETIC-EDIT','hmac-sha256:synthetic:edit','fact','global','none','user','edit-key','edit-digest','mem0','synthetic','existing-project'];
  const edited=await call('sophia_memory_edit',editArgs);
  assert.equal(edited.content_revision,2); checks++;
  const forgetArgs=['receipt-owner',created.memory_id,2,'user','forget-key','forget-digest'];
  const forgotten=await call('sophia_memory_forget',forgetArgs);
  assert.equal(forgotten.resulting_lifecycle,'forgotten'); checks++;
  const restoreArgs=['receipt-owner',created.memory_id,3,'user','restore-key','restore-digest','mem0','synthetic','existing-project'];
  const restored=await call('sophia_memory_restore',restoreArgs);
  assert.equal(restored.resulting_lifecycle,'active'); checks++;
  const tombArgs=['receipt-owner',created.memory_id,4,'user','delete-key','delete-digest'];
  const deleted=await call('sophia_memory_tombstone',tombArgs);
  assert.equal(deleted.resulting_lifecycle,'tombstoned'); checks++;
  assert(deleted.tombstone_id); checks++;
  const replay=await call('sophia_memory_tombstone',tombArgs);
  assert.deepEqual(replay,{...deleted,idempotent_replay:true}); checks++;
  const oldCreate=await call('sophia_memory_manual_create',createArgs);
  assert.deepEqual(oldCreate,{...created,idempotent_replay:true}); checks++;
  assert.equal((await one('select lifecycle from sophia_memories where memory_id=$1',[created.memory_id])).lifecycle,'tombstoned'); checks++;
  for (const [name,args,original] of [['edit',editArgs,edited],['forget',forgetArgs,forgotten],['restore',restoreArgs,restored]]) {
    assert.deepEqual(await call('sophia_memory_'+name,args),{...original,idempotent_replay:true}); checks++;
  }
  assert.equal((await one("select count(*)::int n from sophia_memory_governance_events where user_id='receipt-owner'")).n,5); checks++;
  await assert.rejects(call('sophia_memory_manual_create',[...createArgs.slice(0,8),'different-digest',...createArgs.slice(9)]),/memory_idempotency_digest_conflict/); checks++;
  for (const name of ['approve_candidate','reject_candidate','manual_create','edit','forget','restore','tombstone']) {
    const { definition }=await one("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname=$1",['sophia_memory_'+name]);
    const begin=definition.indexOf('\nBEGIN');
    const lock=definition.indexOf('sophia_memory_ensure_governance(p_user_id)',begin);
    const lookup=definition.indexOf('SELECT * INTO event',begin);
    assert(lock>=0 && lock<lookup, `${name} reads its receipt before owner serialization`); checks++;
  }
  await db.exec('set role service_role');
  await assert.rejects(call('sophia_memory_command_receipt',['receipt-owner','create-key',JSON.stringify({idempotent_replay:true})]),/permission denied/); checks++;
  console.log(JSON.stringify({schema:'mem00.c1-command-receipts-sql.v1',passed:true,checks,production_mutations:0,
    cleanup:'entire disposable database closed',scope:'Actual RPC complete historical receipt after tombstone; SQL lock-before-lookup structure. Independent multi-process concurrency remains unproven.'}));
} catch(error) {
  console.error(JSON.stringify({schema:'mem00.c1-command-receipts-sql.v1',passed:false,checks_completed:checks,
    error_code:error.code??'assertion',reason:String(error.message).split('\n')[0],production_mutations:0}));
  process.exitCode=1;
} finally {await db.close();}
