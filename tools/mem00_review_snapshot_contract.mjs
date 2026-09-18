// Disposable database certification of the actual staged read RPC; no live data.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import {frontendExecutionProof} from './mem00_frontend_execution_proof.mjs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { PGlite }=await import(pathToFileURL(process.argv[2]).href);
const root=new URL('../',import.meta.url),db=new PGlite();
let checks=0,frontendProof=null;
let manifest='hmac-sha256:synthetic:manifest';
let composed=null;
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const target=[{message_id:'message-1',sequence:1}];
const read=async({snapshot=null,after=null,size=100,revision=1,owner='review-owner',messages=target}={}) =>
  (await one('select public.sophia_memory_review_snapshot($1,$2,$3,$4,$5,$6,$7,$8) value',
    [owner,'review-session',revision,manifest,JSON.stringify(messages),snapshot,after,size])).value;
try {
  if(process.argv[3]) {
    const prepared=spawnSync(process.argv[3],['run','python','../tools/mem00_review_snapshot_composed.py','--manifest'],
      {cwd:new URL('backend/',root),env:{...process.env,PYTHONPATH:'.'},encoding:'utf8',timeout:30000});
    assert.equal(prepared.status,0,'composed manifest preparation failed');
    manifest=JSON.parse(prepared.stdout).manifest;
  }
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table sophia_sessions(id text primary key,user_id text,thread_id text,message_revision bigint,memory_processed_until_sequence bigint,status text,ended_at timestamptz,updated_at timestamptz,metadata jsonb default '{}');
    create table sophia_session_messages(id text,message_id text,session_id text,user_id text,thread_id text default 'review-thread',sequence bigint,role text,content text,final boolean);`);
  for(const name of ['2026_09_02_mem00_durable_memory_governance.sql','2026_09_08_mem00_c1_owner_authority.sql','2026_09_08_mem00_c1_command_receipts.sql','2026_09_09_mem00_c1_dependency_authority.sql','2026_09_09_mem00_c1_review_snapshot.sql']) {
    await db.exec(readFileSync(new URL('backend/migrations/'+name,root),'utf8'));
  }
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_review_snapshot.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_source_decision_fence.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_transactional_clear.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_source_intake.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_extraction_dispatch.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_epoch_source_target.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_epoch_review.sql',root),'utf8'));
  assert.equal((await read()).extraction_state,'unavailable');checks++;
  await db.exec(`update sophia_memory_contract set mode='enforced';
    select sophia_memory_declare_owner_authority('review-owner','unknown','governed',1,'hmac-sha256:synthetic:approval');`);
  assert.equal((await read()).extraction_state,'not_found');checks++;
  await db.exec(`insert into sophia_sessions values('review-session','review-owner','review-thread',1,0,'active',null,now());
    insert into sophia_session_messages(id,message_id,session_id,user_id,sequence,role,content,final) values('row-1','message-1','review-session','review-owner',1,'user','SYNTHETIC-SOURCE',true);`);
  target[0].source_version=(await one('select memory_source_version from sophia_session_messages')).memory_source_version;
  assert.equal((await read()).extraction_state,'awaiting_finalization');checks++;
  assert.equal((await read({messages:[]})).extraction_state,'source_changed','omitted transcript rows must not certify an empty target');checks++;
  await db.exec("update sophia_sessions set status='ended',ended_at=now()");
  assert.equal((await read()).extraction_state,'awaiting_finalization','an ended row without a source-target receipt is not proof of finalized memory input');checks++;
  await db.query(`insert into sophia_memory_governance_events(user_id,event_type,actor_kind,source_session_id,operation_id,idempotency_key,request_digest,source_target_receipt)
    select 'review-owner','source_target_aligned','system','review-session','synthetic-finalize','synthetic-finalize','synthetic-finalize',jsonb_build_object('source_manifest_ref',$1::text,
      'source_target',jsonb_build_object('owner_id',user_id,'session_id',id,'thread_id',thread_id,'transcript_revision',message_revision,
        'source_manifest_ref',$1::text,'status',status,'ended_at',ended_at,'message_count',1,'sequence_start',1,'sequence_end',1,'source_dependencies',$2::jsonb)) from sophia_sessions`,[manifest,JSON.stringify(target)]);
  assert.equal((await read()).extraction_state,'processing');checks++;
  for(const [field,value] of [['owner_id','other-owner'],['session_id','other-session'],['thread_id','other-thread'],['source_manifest_ref','other-ref'],['transcript_revision',2],['message_count',2],['sequence_end',2],['ended_at','2026-01-01T00:00:00Z']]) {
    await db.exec('begin');
    await db.query("update sophia_memory_governance_events set source_target_receipt=jsonb_set(source_target_receipt,ARRAY['source_target',$1],$2::jsonb) where event_type='source_target_aligned'",[field,JSON.stringify(value)]);
    assert.equal((await read()).extraction_state,'awaiting_finalization','mismatched receipt '+field);
    await db.exec('rollback');checks++;
  }
  const run=await one(`insert into sophia_memory_extraction_runs(user_id,idempotency_key,request_digest,session_id,thread_id,modality,
    transcript_revision,sequence_start,sequence_end,input_manifest_ref,extractor_contract_version,extractor_model,extractor_prompt_version)
    values('review-owner','synthetic-key','synthetic-digest','review-session','review-thread','text',1,1,1,
    'hmac-sha256:synthetic:manifest','mem00.extract.v1','existing-model','existing-prompt') returning extraction_run_id`);
  await db.query('update sophia_memory_extraction_runs set input_manifest_ref=$1',[manifest]);
  await db.query('update sophia_memory_extraction_runs set source_dependencies=$1,validated_transcript_revision=1',[JSON.stringify(target)]);
  await db.query('update sophia_memory_extraction_runs set extractor_input_context=$1,extractor_input_ref=$2',[
    JSON.stringify({schema:'mem00.extract-input.v1',session_date:'2026-09-09',context_mode:'life',template_sha256:'a'.repeat(64)}),
    'hmac-sha256:extractor-input:'+'b'.repeat(64)]);
  assert.equal((await read()).extraction_state,'processing');checks++;
  for(const [state,expected] of [['retry_wait','failed_retryable'],['failed_terminal','failed_terminal']]) {
    await db.query('update sophia_memory_extraction_runs set state=$1',[state]);
    assert.equal((await read()).extraction_state,expected);checks++;
  }
  await db.exec("update sophia_memory_extraction_runs set state='succeeded_zero',terminal_candidate_count=0,processed_through_sequence=1");
  let view=await read();
  assert.equal(view.extraction_state,'complete');assert.equal(view.summary.produced,0);assert.equal(view.enumeration_complete,true);checks+=3;
  await db.query(`insert into sophia_memory_candidates(user_id,extraction_run_id,stable_ordinal,producer,origin)
    select 'review-owner',$1,n,'synthetic','synthetic' from generate_series(1,1005) n`,[run.extraction_run_id]);
  await db.exec(`insert into sophia_memory_candidate_versions(candidate_id,user_id,candidate_revision,proposed_content,content_ref,category,creating_actor,creation_reason)
    select candidate_id,user_id,1,'SYNTHETIC-CANDIDATE-'||stable_ordinal,'hmac-sha256:synthetic:'||stable_ordinal,'fact','synthetic','synthetic' from sophia_memory_candidates;
    insert into sophia_memory_candidate_sources(candidate_id,user_id,session_id,message_id,sequence,transcript_revision)
    select candidate_id,user_id,'review-session','message-1',1,1 from sophia_memory_candidates;
    update sophia_memory_extraction_runs set state='succeeded_nonzero',terminal_candidate_count=1005;`);
  // EI843: a fixture row is not automatically a published, source-bound candidate.
  await db.exec('begin');
  try {
    await db.exec('update sophia_memory_extraction_runs set terminal_candidate_count=1004');
    const inconsistent = await read();
    assert.equal(inconsistent.extraction_state,'unavailable');
    assert.deepEqual(inconsistent.candidates,[]); checks+=2;
  } finally { await db.exec('rollback'); }
  await db.exec('begin');
  try {
    const unbound = await one('select candidate_id from sophia_memory_candidates where stable_ordinal=1');
    await db.query('delete from sophia_memory_candidate_sources where candidate_id=$1',[unbound.candidate_id]);
    const unlinked = await read({size:200});
    assert.equal(unlinked.summary.pending,1004);
    assert.equal(unlinked.summary.invalidated,1);
    assert(!unlinked.candidates.some(item=>item.candidate_id===unbound.candidate_id)); checks+=3;
  } finally { await db.exec('rollback'); }
  const seen=new Set();let after=null,snapshot=null,pages=0;const sqlPages=[];
  do {
    view=await read({snapshot,after,size:200});
    sqlPages.push(view);
    assert.equal(view.extraction_state,'complete');assert.equal(view.summary.pending,1005);
    for(const candidate of view.candidates) {assert(!seen.has(candidate.candidate_id));seen.add(candidate.candidate_id);assert(candidate.content);}
    snapshot=view.snapshot_id;after=view.next_after_candidate_id;pages++;
  }while(!view.enumeration_complete);
  assert.equal(seen.size,1005);assert.equal(pages,6);checks+=2;
  if(process.argv[3]) {
    const composedPages=[];let composedAfter=null,composedSnapshot=null,composedPage;
    do {
      composedPage=await read({snapshot:composedSnapshot,after:composedAfter,size:100});
      composedPages.push(composedPage);composedAfter=composedPage.next_after_candidate_id;composedSnapshot=composedPage.snapshot_id;
    }while(!composedPage.enumeration_complete);
    const input={pages:composedPages,source_snapshot:(await one("select sophia_memory_source_snapshot('review-owner','review-session','review-thread') value")).value,source_version:target[0].source_version,contract:await one('select * from sophia_memory_contract where singleton'),
      owner:await one("select user_id,authority_state,authority_epoch,authority_declared_at from sophia_memory_user_governance where user_id='review-owner'")};
    const gateway=spawnSync(process.argv[3],['run','python','../tools/mem00_review_snapshot_composed.py'],
      {cwd:new URL('backend/',root),env:{...process.env,PYTHONPATH:'.'},encoding:'utf8',input:JSON.stringify(input),timeout:30000,maxBuffer:4*1024*1024});
    assert.equal(gateway.status,0,gateway.stderr.split('\n').find(line=>line.startsWith('MEM00_GATEWAY_DIAGNOSTIC '))||'actual Gateway composition failed');
    const output=JSON.parse(gateway.stdout);assert(output.passed);checks++;
    composed={gateway_pages:output.request_count,provider_calls:output.provider_calls,frontend:false};
    if(process.argv[4]) {
      const directory=mkdtempSync(join(tmpdir(),'mem00-review-composed-'));
      const fixture=join(directory,'synthetic-pages.json');
      try {
        writeFileSync(fixture,JSON.stringify(output),{mode:0o600});
        const frontend=spawnSync(process.argv[4],['node_modules/vitest/vitest.mjs','run','src/__tests__/recap/canonical-review-composed.test.tsx','--reporter=json','--outputFile='+join(directory,'frontend.private.json')],
          {cwd:new URL('frontend/',root),env:{...process.env,MEM00_REVIEW_COMPOSED_FIXTURE:fixture},encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
        assert.equal(frontend.status,0,'actual Next/recap composition failed');
        frontendProof=frontendExecutionProof(readFileSync(join(directory,'frontend.private.json'),'utf8'),2);
        composed.frontend=true;checks++;
      }finally{if(existsSync(join(directory,'frontend.private.json')))unlinkSync(join(directory,'frontend.private.json'));unlinkSync(fixture);rmdirSync(directory);}
    }
  }
  await db.exec("update sophia_memory_candidates set review_state='rejected'");
  assert.equal((await read({snapshot})).extraction_state,'snapshot_changed');checks++;
  view=await read();assert.equal(view.summary.produced,1005);assert.equal(view.summary.rejected,1005);
  assert.equal(view.summary.pending,0);assert.equal(view.extraction_state,'complete');checks+=4;
  await db.exec("update sophia_memory_candidates set review_state='pending_review'; update sophia_memory_candidates set created_at=now()-interval '31 days' where stable_ordinal=1");
  view=await read();assert.equal(view.summary.pending,1004);
  assert.equal(view.summary.invalidated,1,'expired pending candidate vanished from review summary');checks+=2;
  await db.exec("update sophia_memory_candidates set review_state='rejected' where stable_ordinal=1; update sophia_memory_candidate_sources set detached_at=now() where candidate_id=(select candidate_id from sophia_memory_candidates where stable_ordinal=1)");
  view=await read();assert.equal(view.summary.rejected,1);assert.equal(view.summary.invalidated,0,'reviewed candidate counted twice after source detachment');checks+=2;
  assert.equal((await read({revision:2})).extraction_state,'source_changed');checks++;
  assert.equal((await read({owner:'wrong-owner'})).candidates.length,0);checks++;
  await db.exec('set role authenticated');
  await assert.rejects(read(),/permission denied/);checks++;
  console.log(JSON.stringify({schema:'mem00.c1-review-snapshot-sql.v1',passed:true,checks,pages,
    enumerated_candidates:seen.size,composed,frontend_execution:frontendProof,production_mutations:0,cleanup:'entire disposable database and any synthetic transport file removed',
    scope:'Actual one-snapshot joins,1005-row paging,changed view rejection and extraction-vs-review counts. Exact append/correction dependency reuse remains separate.'}));
} catch(error) {
  console.error(JSON.stringify({schema:'mem00.c1-review-snapshot-sql.v1',passed:false,checks_completed:checks,
    reason:String(error.message).split('\n')[0],error_code:error.code??'assertion',production_mutations:0}));process.exitCode=1;
} finally {await db.close();}
