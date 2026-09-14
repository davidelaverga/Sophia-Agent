// Disposable SQL contract. No production connection, application grants or provider calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const root = new URL('../backend/migrations/', import.meta.url);
const selected = [
  '2026_09_02_mem00_durable_memory_governance.sql',
  '2026_09_08_mem00_c1_owner_authority.sql',
  '2026_09_08_mem00_c1_command_receipts.sql',
  '2026_09_09_mem00_c1_dependency_authority.sql',
  '2026_09_09_mem00_c1_review_snapshot.sql',
  '2026_09_09_mem00_c1_snapshot_inventory.sql',
  '2026_09_09_mem00_c1_source_decision_fence.sql',
  '2026_09_09_mem00_c1_transactional_clear.sql',
  '2026_09_09_mem00_c1_source_intake.sql',
  '2026_09_09_mem00_c1_extraction_dispatch.sql',
  '2026_09_09_mem00_c1_epoch_source_target.sql',
  '2026_09_09_mem00_c1_epoch_review.sql',
];
const migration = readFileSync(new URL('2026_09_14_mem00_c2_model_authority.sql', root), 'utf8');
let checks = 0;
const one = async (sql, args=[]) => (await db.query(sql, args)).rows[0];
const rpc = async (name, args) => (await one(`select public.${name}(${args.map((_, i)=>'$'+(i+1)).join(',')}) value`, args)).value;
const ref = (domain) => 'hmac-sha256:'+domain+':'+'a'.repeat(64);
const denied = async (action, pattern) => { await assert.rejects(action, pattern); checks++; };
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table sophia_sessions(id text primary key,user_id text,thread_id text,message_revision bigint,memory_processed_until_sequence bigint,status text,ended_at timestamptz,updated_at timestamptz,metadata jsonb default '{}',transcript_available boolean);
    create table sophia_session_messages(id text,message_id text,session_id text,user_id text,thread_id text,sequence bigint,role text,content text,final boolean,source text,approximate boolean,created_at timestamptz,metadata jsonb);`);
  for (const name of selected) await db.exec(readFileSync(new URL(name, root), 'utf8'));
  await db.exec(`update sophia_memory_contract set mode='enforced';
    select sophia_memory_declare_owner_authority('c2-synthetic','unknown','governed',1,'hmac-sha256:synthetic:declaration');`);
  const before = await one("select * from sophia_memory_user_governance where user_id='c2-synthetic'");
  await db.exec(migration);
  await db.exec(migration);
  assert.deepEqual(await one("select * from sophia_memory_user_governance where user_id='c2-synthetic'"), before); checks++;

  const names = [...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map(m=>m[1]);
  const privileges = (await db.query(`select proname,rolname,has_function_privilege(rolname,p.oid,'EXECUTE') allowed
    from pg_proc p cross join pg_roles r where p.pronamespace='public'::regnamespace
    and p.proname=ANY($1::text[]) and rolname=ANY($2::text[])`, [names,['anon','authenticated','service_role']])).rows;
  assert.equal(privileges.length, names.length*3);
  for (const row of privileges) { assert.equal(row.allowed,false,row.proname+':'+row.rolname); checks++; }
  const thread = randomUUID(), run = randomUUID(), child = randomUUID();
  await db.query(`insert into sophia_sessions(id,user_id,thread_id,message_revision,status)
    values('c2-session','c2-synthetic',$1,0,'active')`,[thread]);
  const source = await rpc('sophia_memory_accept_source_action',[
    'c2-synthetic','c2-session',thread,'c2-message-1',randomUUID(),'SYNTHETIC make a table',0,
    'c2-command-1',ref('request'),ref('source-action-content')]);
  const witness = Object.fromEntries(['owner_id','session_id','thread_id','command_key','event_id','message_id','source_row_id','source_version','sequence','memory_clear_epoch','content_ref'].map(k=>[k,source[k]]));
  witness.schema='mem00.recorded-input-source.v1';
  const admission = async (scope='life', manifest=[]) => rpc('sophia_memory_record_prompt_admission',[
    randomUUID(),'c2-synthetic','synthetic',scope,ref('query'),'mem0','synthetic','existing-project',before.provider_subject,
    'ok',0,0,0,JSON.stringify(manifest),'{}',manifest.length?'authorized':'zero_memory',null,'{}']);
  const attempt = async (scope='life') => ({
    schema:'mem00.model-attempt.v4',attempt_id:randomUUID(),run_id:run,thread_id:thread,
    scope,contract_epoch:1,provider:'mem0',environment:'synthetic',provider_project:'existing-project',
    provider_namespace:before.provider_subject,prior_admission_id:await admission(scope),
    catalog_generation:0,revocation_epoch:0,authorized_manifest:[],source_witness:witness,
    source_dependencies:[witness],builder_binding:null,completion_binding:null,
    payload_ref:ref('model-payload'),endpoint_ref:ref('model-endpoint'),model_ref:ref('model-route'),
  });
  const dispatch = (value,owner='c2-synthetic') => rpc('sophia_memory_authorize_model_dispatch',[owner,JSON.stringify(value)]);
  const ordinary = await attempt();
  const permit = await dispatch(ordinary);
  assert.equal(permit.schema,'mem00.model-dispatch.v4');
  assert.deepEqual(permit.authorized_manifest,[]); checks+=2;
  await denied(()=>dispatch(ordinary),/memory_model_attempt_consumed/);
  await denied(()=>dispatch({...ordinary,attempt_id:randomUUID()},'other-owner'),/memory_owner_authority_required/);
  await denied(async()=>dispatch({...await attempt(),thread_id:randomUUID()}),/memory_model_source_thread_changed/);
  await denied(async()=>dispatch({...await attempt(),completion_binding:{binding_event_id:randomUUID()},source_witness:null}),/memory_c2_consumer_disabled/);
  const handoff = {schema:'mem00.builder-source-handoff.v1',catalog_generation:0,revocation_epoch:0,
    contract_epoch:1,child_thread_id:child,parent_thread_id:thread,parent_run_id:run,
    initial_memory_manifest:[],payload_ref:ref('checkpoint-state'),prior_admission_id:await admission(),scope:'life',source_dependencies:[witness]};
  const register = value => rpc('sophia_memory_register_builder_handoff',['c2-synthetic',JSON.stringify(value)]);
  await denied(()=>register({...handoff,initial_memory_manifest:[{memory_id:randomUUID()}]}),/memory_builder_handoff_invalid/);
  const registered = await register(handoff);
  assert.deepEqual(await register(handoff),registered); checks++;
  assert.equal(await rpc('sophia_memory_get_builder_handoff',['other-owner',child]),null); checks++;
  const childRun = randomUUID();
  const bound = await rpc('sophia_memory_bind_builder_source_run',['c2-synthetic',registered.event_id,child,childRun,handoff.payload_ref]);
  const builder = {...await attempt('builder'),thread_id:child,run_id:childRun,source_witness:null,builder_binding:bound};
  const childPermit = await dispatch(builder);
  assert.equal(childPermit.builder_binding_id,bound.binding_event_id); checks++;
  await denied(async()=>dispatch({...await attempt('builder'),thread_id:child,run_id:childRun,source_witness:null,
    builder_binding:{...bound,initial_memory_manifest:[{memory_id:randomUUID()}]}}),/memory_c2_consumer_disabled/);
  const request = {schema:'mem00.model-result-request.v1',attempt_id:permit.attempt_id,
    model_admission_event_id:permit.event_id,run_id:run,thread_id:thread,payload_ref:ordinary.payload_ref,
    result_ref:ref('model-result'),tool_calls:[]};
  const result = await rpc('sophia_memory_record_model_result',['c2-synthetic',JSON.stringify(request)]);
  assert.equal(result.model_reuse_permission,false); checks++;
  assert.deepEqual(await rpc('sophia_memory_record_model_result',['c2-synthetic',JSON.stringify(request)]),result); checks++;
  await denied(()=>db.query('delete from sophia_memory_governance_events where event_id=$1',[permit.event_id]),/memory_model_dispatch_receipt_immutable/);
  await denied(()=>db.query('delete from sophia_memory_governance_events where event_id=$1',[result.event_id]),/memory_builder_source_receipt_immutable/);
  await db.exec(migration);
  assert.deepEqual(await rpc('sophia_memory_get_model_result',['c2-synthetic',permit.attempt_id]),result); checks++;
  await db.exec('set role service_role');
  await denied(()=>dispatch({...ordinary,attempt_id:randomUUID()}),/permission denied/);
  await db.exec('reset role');
  if (db.backendKind==='native-postgres') {
    const concurrent = await attempt();
    const first = await db.connectIndependent(), second = await db.connectIndependent();
    const outcomes = await Promise.allSettled([first,second].map(client=>client.query(
      'select sophia_memory_authorize_model_dispatch($1,$2) value',['c2-synthetic',JSON.stringify(concurrent)])));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.match(outcomes.find(x=>x.status==='rejected').reason.message,/memory_model_attempt_consumed/); checks+=2;
    await first.end(); await second.end();
    await db.restart();
    assert.deepEqual(await rpc('sophia_memory_get_model_result',['c2-synthetic',permit.attempt_id]),result); checks++;
    assert.deepEqual(await rpc('sophia_memory_get_builder_handoff',['c2-synthetic',child]),registered); checks++;
    await denied(()=>dispatch(concurrent),/memory_model_attempt_consumed/);
    await db.exec('set role authenticated');
    await denied(()=>dispatch({...ordinary,attempt_id:randomUUID()}),/permission denied/);
    await db.exec('reset role');
  }
  const stale = await attempt();
  await db.exec("update sophia_memory_user_governance set user_revocation_epoch=user_revocation_epoch+1 where user_id='c2-synthetic'");
  await denied(()=>dispatch(stale),/memory_model_governance_changed/);
  // Real canonical transactions; provider binding is explicitly a synthetic
  // observed-projection fixture, never evidence of a hosted provider write.
  const created = await rpc('sophia_memory_manual_create',['c2-synthetic','SYNTHETIC APPROVED FACT',
    ref('canonical-content'),'fact','global','none','user','c2-create','c2-create-digest','mem0','synthetic','existing-project']);
  const manifest = [{memory_id:created.memory_id,content_revision:1,memory_governance_revision:1}];
  const currentAttempt = async (inclusions) => {
    const clock = await one("select * from sophia_memory_user_governance where user_id='c2-synthetic'");
    const prior = await rpc('sophia_memory_record_prompt_admission',[
      randomUUID(),'c2-synthetic','synthetic','life',ref('query'),'mem0','synthetic','existing-project',clock.provider_subject,
      'ok',0,clock.user_catalog_generation,clock.user_revocation_epoch,JSON.stringify(inclusions),'{}','authorized',null,'{}']);
    return {...ordinary,attempt_id:randomUUID(),prior_admission_id:prior,authorized_manifest:inclusions,
      catalog_generation:clock.user_catalog_generation,revocation_epoch:clock.user_revocation_epoch};
  };
  await denied(()=>currentAttempt(manifest),/memory_prompt_admission_denied/);
  await db.query(`insert into sophia_memory_provider_bindings(user_id,memory_id,provider,environment,provider_project,
    provider_namespace,provider_memory_id,canonical_content_revision,memory_governance_revision,projection_operation_id,binding_state,metadata_verification_state)
    values('c2-synthetic',$1,'mem0','synthetic','existing-project',$2,'synthetic-observed-id',1,1,'synthetic-projection','eligible','verified')`,
    [created.memory_id,before.provider_subject]);
  const withMemory = await currentAttempt(manifest);
  assert.deepEqual((await dispatch(withMemory)).authorized_manifest,manifest); checks++;
  const heldBeforeEdit = await currentAttempt(manifest);
  await rpc('sophia_memory_edit',['c2-synthetic',created.memory_id,1,1,'SYNTHETIC EDITED FACT',ref('canonical-edit'),
    'fact','global','none','user','c2-edit','c2-edit-digest','mem0','synthetic','existing-project']);
  await denied(()=>dispatch(heldBeforeEdit),/memory_model_governance_changed/);
  await denied(()=>currentAttempt(manifest),/memory_prompt_admission_denied/);
  const revised = [{memory_id:created.memory_id,content_revision:2,memory_governance_revision:2}];
  await denied(()=>currentAttempt(revised),/memory_prompt_admission_denied/);
  await db.query(`update sophia_memory_provider_bindings set canonical_content_revision=2,
    memory_governance_revision=2,binding_state='eligible' where memory_id=$1`,[created.memory_id]);
  assert.deepEqual((await dispatch(await currentAttempt(revised))).authorized_manifest,revised); checks++;
  const heldBeforeDelete = await currentAttempt(revised);
  await rpc('sophia_memory_tombstone',['c2-synthetic',created.memory_id,2,'user','c2-delete','c2-delete-digest']);
  await denied(()=>dispatch(heldBeforeDelete),/memory_model_governance_changed/);
  await denied(()=>currentAttempt(revised),/memory_prompt_admission_denied/);
  console.log(JSON.stringify({status:'pass',checks,selected_migrations:selected.length+1,
    backend:db.backendKind ?? 'pglite',version:db.backendVersion ?? null,
    coverage:'disposable compile/reapply, preserved rows, revoked execution, source-only dispatch/binding/result, canonical edit/tombstone admission',
    native_restart_and_duplicate_dispatch:db.backendKind==='native-postgres',
    not_proven:['production upgrade','serving grants','hosted model'] }));
} finally { await db.close(); }
