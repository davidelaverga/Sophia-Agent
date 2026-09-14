// Disposable current-state inventory: no production/provider calls.
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync, existsSync} from 'node:fs';
import {frontendExecutionProof} from './mem00_frontend_execution_proof.mjs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {PGlite}=await import(pathToFileURL(process.argv[2]).href);
const db=new PGlite(),root=new URL('../',import.meta.url);let checks=0,frontendProof=null;
const one=async(q,args=[])=>(await db.query(q,args)).rows[0];
const read=async({owner='inventory-owner',view='all',snapshot=null,after=null,size=200}={})=>(await one(
  'select sophia_memory_inventory_snapshot($1,$2,$3,$4,$5) value',[owner,view,snapshot,after,size])).value;
try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create table sophia_sessions(id text primary key,user_id text,thread_id text,message_revision bigint,memory_processed_until_sequence bigint default 0,status text,ended_at timestamptz,updated_at timestamptz,metadata jsonb default '{}',
      recap_processed_until_sequence bigint default 0,last_memory_extraction_at timestamptz,last_recap_extraction_at timestamptz,last_memory_extraction_run_id text,memory_extraction_status text,memory_extraction_error_code text,memory_extraction_range_start bigint,memory_extraction_range_end bigint);
    create table sophia_session_messages(id text primary key,message_id text,session_id text,user_id text,thread_id text default 'thread',sequence bigint,role text,content text,final boolean);`);
  const migrations=['2026_09_02_mem00_durable_memory_governance.sql','2026_09_08_mem00_c1_owner_authority.sql',
    '2026_09_08_mem00_c1_command_receipts.sql','2026_09_09_mem00_c1_dependency_authority.sql',
    '2026_09_09_mem00_c1_review_snapshot.sql','2026_09_09_mem00_c1_snapshot_inventory.sql'];
  for(const name of migrations)await db.exec(readFileSync(new URL('backend/migrations/'+name,root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/'+migrations.at(-1),root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_source_decision_fence.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_transactional_clear.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_source_intake.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_extraction_dispatch.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_epoch_source_target.sql',root),'utf8'));
  await db.exec(readFileSync(new URL('backend/migrations/2026_09_09_mem00_c1_epoch_review.sql',root),'utf8'));
  await db.exec(`update sophia_memory_contract set mode='enforced';
    select sophia_memory_declare_owner_authority('inventory-owner','unknown','governed',1,'hmac-sha256:synthetic:inventory');
    select sophia_memory_declare_owner_authority('other-owner','unknown','governed',1,'hmac-sha256:synthetic:other-owner');
    insert into sophia_sessions(id,user_id,thread_id,message_revision,status,ended_at) values('session','inventory-owner','thread',1,'ended','2026-09-09T00:00:00Z');
    insert into sophia_session_messages(id,message_id,session_id,user_id,sequence,role,content,final)
      values('row','message','session','inventory-owner',1,'user','SYNTHETIC_SOURCE_NOT_EXPORTED',true);
    insert into sophia_memories(memory_id,user_id,lifecycle,current_content_revision)
      select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'inventory-owner',CASE WHEN n%5=0 THEN 'forgotten' ELSE 'active' END,2
      from generate_series(1,1005)n;
    insert into sophia_memories(memory_id,user_id) values('20000000-0000-4000-8000-000000000001','other-owner');
    insert into sophia_memory_versions(memory_id,user_id,content_revision,canonical_content,content_ref,category,scope,creation_actor,creation_reason)
      select memory_id,user_id,1,'OLD_OR_WRONG_OWNER','old-ref','fact','global','user','synthetic' from sophia_memories;
    insert into sophia_memory_versions(memory_id,user_id,content_revision,canonical_content,content_ref,category,scope,creation_actor,creation_reason)
      select memory_id,user_id,2,'CURRENT_CANONICAL_'||memory_id,'current-ref-'||memory_id,'fact','global','user','synthetic'
      from sophia_memories where user_id='inventory-owner';`);
  const deps=(await db.query(`select message_id,sequence,memory_source_version as source_version from sophia_session_messages`)).rows;
  const run=await one(`insert into sophia_memory_extraction_runs(user_id,idempotency_key,request_digest,session_id,thread_id,modality,
    transcript_revision,sequence_start,sequence_end,input_manifest_ref,extractor_contract_version,extractor_model,extractor_prompt_version,
    source_dependencies,extractor_input_context,extractor_input_ref,state,terminal_candidate_count,processed_through_sequence)
    values('inventory-owner','synthetic-run','synthetic-digest','session','thread','text',1,1,1,'manifest','mem00.extract.v1','existing-model','existing-prompt',
    $1,$2,$3,'succeeded_nonzero',1005,1) returning extraction_run_id`,[JSON.stringify(deps),
    JSON.stringify({schema:'mem00.extract-input.v1',session_date:'2026-09-09',context_mode:'life',template_sha256:'a'.repeat(64)}),'hmac-sha256:extractor-input:'+'b'.repeat(64)]);
  await db.query(`insert into sophia_memory_candidates(user_id,extraction_run_id,stable_ordinal,producer,origin,current_candidate_revision)
    select 'inventory-owner',$1,n,'synthetic','synthetic',2 from generate_series(1,1005)n`,[run.extraction_run_id]);
  await db.exec(`insert into sophia_memory_candidate_versions(candidate_id,user_id,candidate_revision,proposed_content,content_ref,category,creating_actor,creation_reason)
    select candidate_id,user_id,1,'OLD_CANDIDATE','old-ref','fact','user','synthetic' from sophia_memory_candidates;
    insert into sophia_memory_candidate_versions(candidate_id,user_id,candidate_revision,proposed_content,content_ref,category,creating_actor,creation_reason)
    select candidate_id,user_id,2,'CURRENT_CANDIDATE_'||stable_ordinal,'new-ref-'||stable_ordinal,'fact','user','synthetic' from sophia_memory_candidates;
    insert into sophia_memory_candidate_sources(candidate_id,user_id,session_id,message_id,sequence,transcript_revision)
    select candidate_id,user_id,'session','message',1,1 from sophia_memory_candidates;`);
  const unfinalized=await read({view:'pending_review'});
  assert.equal(unfinalized.total_count,0);assert.equal(unfinalized.summary.unavailable_review_sources,1);checks+=2;
  // Actual source-target aligner produces the finalization witness; no fabricated event.
  const observed=[{extraction_run_id:run.extraction_run_id,state:'succeeded_nonzero',input_manifest_ref:'manifest'}];
  const inputContext={schema:'mem00.extract-input.v1',session_date:'2026-09-09',context_mode:'life',template_sha256:'a'.repeat(64)};
  const witnesses=[{extraction_run_id:run.extraction_run_id,input_manifest_ref:'manifest',dependencies:deps,
    extractor_input_context:inputContext,extractor_input_ref:'hmac-sha256:extractor-input:'+'b'.repeat(64)}];
  const targetArgs=[
    'inventory-owner','session','thread',1,'manifest',JSON.stringify(observed),JSON.stringify(witnesses),null,
    'mem00.extract.v1','existing-model','existing-prompt','text','2026-09-09T00:00:00Z','inventory-finalize','digest-inventory-finalize'];
  const align=async(args)=>(await one('select sophia_memory_apply_source_target($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) value',args)).value;
  const receipt=await align(targetArgs);
  assert.deepEqual(receipt.source_target.source_dependencies,deps);checks++;
  let page,after=null,snapshot=null,pages=0;const records=[],sqlPages=[];
  do {
    page=await read({snapshot,after});assert.equal(page.status,'available');assert.equal(page.total_count,2010);
    assert.equal(page.summary.reviewable_pending,1005);assert.equal(page.extraction_complete,false);
    records.push(...page.records);sqlPages.push(page);after=page.next_after_key;snapshot=page.snapshot_id;pages++;
    assert(pages<20);
  }while(!page.enumeration_complete);
  assert.equal(records.length,2010);assert.equal(new Set(records.map(r=>r.kind+':'+r.id)).size,2010);checks+=2;
  assert(records.every(r=>r.revision===2 && r.content?.startsWith('CURRENT_')));checks++;
  assert(!JSON.stringify(records).includes('OLD_'));assert(!JSON.stringify(records).includes('SYNTHETIC_SOURCE_NOT_EXPORTED'));checks+=2;
  assert.equal((await read({view:'active'})).total_count,804);assert.equal((await read({view:'forgotten'})).total_count,201);checks+=2;
  const pending=await read({view:'pending_review'});assert.equal(pending.total_count,1005);assert(pending.records.every(r=>r.reviewable));checks+=2;
  const review=(await one('select sophia_memory_review_snapshot($1,$2,$3,$4,$5,$6,$7,$8) value',[
    'inventory-owner','session',1,'manifest',JSON.stringify(deps),null,null,200])).value;
  assert.equal(review.candidates.length,pending.records.length,JSON.stringify({review_state:review.extraction_state,review_count:review.candidates.length,inventory_count:pending.records.length}));
  assert.deepEqual(pending.records.map(r=>[r.id,r.revision]),review.candidates.map(c=>[c.candidate_id,c.candidate_revision]));checks++;
  const savedPages=[],activePages=[],forgottenPages=[];
  for(const [view,target] of [['saved',savedPages],['active',activePages],['forgotten',forgottenPages]]){
    let a=null,s=null,p;
    do{p=await read({view,after:a,snapshot:s});target.push(p);a=p.next_after_key;s=p.snapshot_id;}while(!p.enumeration_complete);
  }
  assert.equal(savedPages.reduce((n,p)=>n+p.records.length,0),1005);checks++;
  const namespace=(await one("select provider_subject from sophia_memory_user_governance where user_id='inventory-owner'")).provider_subject;
  await db.exec(`insert into sophia_memory_provider_bindings(user_id,memory_id,provider,environment,provider_project,provider_namespace,
      provider_memory_id,canonical_content_revision,memory_governance_revision,projection_operation_id,binding_state,metadata_verification_state)
    select m.user_id,memory_id,'mem0','synthetic','existing-project',g.provider_subject,'provider-'||memory_id,
      current_content_revision,memory_governance_revision,'synthetic-binding','eligible','verified'
      from sophia_memories m join sophia_memory_user_governance g on g.user_id=m.user_id where m.user_id='inventory-owner';`);
  const validId='provider-10000000-0000-4000-8000-000000001004';
  const hits=async(ids,selectedNamespace=namespace)=>(await one(
    'select sophia_memory_resolve_provider_hits($1,$2,$3,$4,$5,$6) value',
    ['inventory-owner','mem0','synthetic','existing-project',selectedNamespace,JSON.stringify(ids)])).value;
  const hitIds=[validId,'provider-10000000-0000-4000-8000-000000001005','unmapped-id'];
  const hitResult=await hits(hitIds);
  assert.equal(hitResult.status,'available');assert.equal(hitResult.final_admission,false);
  assert.equal(hitResult.results[0].memory.canonical_content,'CURRENT_CANONICAL_10000000-0000-4000-8000-000000001004');
  assert.equal(hitResult.results[1].denial_reason,'inactive_projection');
  assert.equal(hitResult.results[2].denial_reason,'unmapped_provider_id');checks+=3;
  assert.deepEqual((await hits(hitIds,'wrong-namespace')).results,[]);checks++;
  for(const invalid of [[validId,validId],[''],[' spaced '],Array.from({length:101},(_,i)=>'id-'+i)]){
    await assert.rejects(hits(invalid),/memory_hit_selector_invalid/);checks++;
  }
  if(process.argv[3]){
    const fixture={pages:sqlPages,saved_pages:savedPages,active_pages:activePages,forgotten_pages:forgottenPages,hit_ids:hitIds,hit_result:hitResult,
      views:{active:await read({view:'active'}),forgotten:await read({view:'forgotten'}),pending_review:pending},
      contract:await one('select * from sophia_memory_contract'),
      owner:await one("select * from sophia_memory_user_governance where user_id='inventory-owner'")};
    const gateway=spawnSync(process.argv[3],['run','python','../tools/mem00_inventory_composed.py'],
      {cwd:new URL('backend/',root),env:{...process.env,PYTHONPATH:'.'},input:JSON.stringify(fixture),encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    assert.equal(gateway.status,0,'actual Gateway inventory composition failed: '+gateway.stderr.slice(-1500).replaceAll('\n',' | '));
    const output=JSON.parse(gateway.stdout);assert.equal(output.request_count,32);checks++;
    if(process.argv[4]){
      const directory=mkdtempSync(join(tmpdir(),'mem00-inventory-composed-'));
      const fixturePath=join(directory,'synthetic-pages.json'),report=join(directory,'frontend.private.json');
      try{
        writeFileSync(fixturePath,JSON.stringify(output),{mode:0o600});
        // C2 qualifies the ordinary Pool; optional account/bulk export is separate.
        const poolOnly=process.argv.includes('--pool-only');
        const frontend=spawnSync(process.argv[4],['node_modules/vitest/vitest.mjs','run',...(poolOnly?[]:['src/__tests__/api/inventory-composed.route.test.ts']),'src/__tests__/components/pool-inventory-composed.test.tsx','--reporter=json','--outputFile='+report],
          {cwd:new URL('frontend/',root),env:{...process.env,MEM00_INVENTORY_COMPOSED_FIXTURE:fixturePath,DEBUG_PRINT_LIMIT:'200'},encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
        assert.equal(frontend.status,0,'actual Next inventory composition failed: '+JSON.stringify({status:frontend.status,signal:frontend.signal,error:frontend.error?.code})
          +' '+frontend.stdout.slice(-2000)+frontend.stderr.slice(-2000));checks++;
        frontendProof={...frontendExecutionProof(readFileSync(report,'utf8'),poolOnly?1:4),scope:poolOnly?'ordinary_pool_only':'pool_and_inventory_export'};
      }finally{if(existsSync(report))unlinkSync(report);unlinkSync(fixturePath);rmdirSync(directory);}
    }
  }
  await db.exec(`insert into sophia_memory_provider_bindings(user_id,memory_id,provider,environment,provider_project,provider_namespace,
    provider_memory_id,canonical_content_revision,memory_governance_revision,projection_operation_id,binding_state,metadata_verification_state)
    select user_id,memory_id,provider,environment,provider_project,provider_namespace,'duplicate-physical-id',
      canonical_content_revision,memory_governance_revision,projection_operation_id,binding_state,metadata_verification_state
      from sophia_memory_provider_bindings where provider_memory_id='${validId}'`);
  const repeatedCanonical=await hits([validId,'duplicate-physical-id']);
  assert(repeatedCanonical.results.every(item=>item.denial_reason===null),'valid provider IDs for one current canonical memory require rank-preserving deduplication');
  assert.equal(repeatedCanonical.results[0].memory.memory_id,repeatedCanonical.results[1].memory.memory_id);checks++;
  await db.exec(`update sophia_memory_provider_bindings set binding_state='purged' where provider_memory_id='duplicate-physical-id'`);
  await db.exec(`update sophia_memory_provider_bindings set canonical_content_revision=1 where provider_memory_id='${validId}'`);
  assert.equal((await hits([validId])).results[0].denial_reason,'stale_content_revision');checks++;
  await db.exec(`update sophia_memory_provider_bindings set canonical_content_revision=2,memory_governance_revision=999 where provider_memory_id='${validId}'`);
  assert.equal((await hits([validId])).results[0].denial_reason,'stale_memory_governance_revision');checks++;
  // Simulate a historical receipt created before full source-witness capture.
  await db.exec(`update sophia_memory_governance_events set source_target_receipt=source_target_receipt #- '{source_target,source_dependencies}'
    where user_id='inventory-owner' and event_type='source_target_aligned'`);
  assert.equal((await read({view:'pending_review'})).total_count,0);checks++;
  const historical=await align(targetArgs);
  assert.equal(historical.source_target.source_dependencies,undefined);checks++;
  assert.equal((await read({view:'pending_review'})).total_count,0);checks++;
  const revalidated=await align([...targetArgs.slice(0,13),'inventory-finalize-v2','digest-inventory-finalize-v2']);
  assert.deepEqual(revalidated.source_target.source_dependencies,deps);checks++;
  assert.equal((await read({view:'pending_review'})).total_count,1005);checks++;
  assert.equal((await one("select count(*)::integer n from sophia_memory_extraction_runs where user_id='inventory-owner'")).n,1);checks++;
  for(const owner of ['unknown-owner','other-owner']){
    const result=await read({owner,snapshot});assert.notEqual(result.status,'available');assert.deepEqual(result.records,[]);assert.equal(result.total_count,null);checks++;
  }
  for(const fault of [{size:0},{size:201},{size:null},{view:'wrong'},{after:'memory:invalid'},{after:records[0].kind+':'+records[0].id}]){
    await assert.rejects(read(fault),/memory_inventory_request_invalid/);checks++;
  }
  await db.exec(`update sophia_memory_candidates set review_state='rejected' where stable_ordinal=1`);
  let changed=await read({snapshot});assert.equal(changed.status,'snapshot_changed');assert.deepEqual(changed.records,[]);checks++;
  let rejected=(await read()).records.find(r=>r.state==='rejected');
  // UUID sorting can place it after the first page; select its explicit key range.
  if(!rejected){const id=(await one('select candidate_id from sophia_memory_candidates where stable_ordinal=1')).candidate_id;
    rejected=records.find(r=>r.id===id);const all=[];let a=null,s=null,p;
    do{p=await read({after:a,snapshot:s});all.push(...p.records);a=p.next_after_key;s=p.snapshot_id;}while(!p.enumeration_complete);
    rejected=all.find(r=>r.id===id);}
  assert.equal(rejected.content,null);assert.equal(rejected.reviewable,false);checks++;
  await align([...targetArgs.slice(0,13),'inventory-finalize-v2-recheck','digest-inventory-finalize-v2-recheck']);
  assert.equal((await read({view:'pending_review'})).total_count,1004);
  assert.equal((await one("select count(*)::integer n from sophia_memory_extraction_runs where user_id='inventory-owner'")).n,1);checks++;
  await db.exec(`update sophia_session_messages set content='CORRECTED_SYNTHETIC_SOURCE'`);
  changed=await read({view:'pending_review'});assert.equal(changed.total_count,0);assert.equal(changed.summary.withheld_candidates,1005);checks+=2;
  await db.exec(`insert into sophia_memory_tombstones(user_id,memory_id,last_content_revision,tombstone_governance_revision,user_revocation_epoch)
    values('inventory-owner','10000000-0000-4000-8000-000000000001',2,1,1)`);
  const inconsistent=await read({view:'active'});
  assert.equal(inconsistent.status,'unavailable');assert.deepEqual(inconsistent.records,[]);checks++;
  const fencedHit=await hits(['provider-10000000-0000-4000-8000-000000000001']);
  assert.equal(fencedHit.results[0].denial_reason,'inactive_projection');assert.equal(fencedHit.results[0].memory,null);checks++;
  await db.exec(`update sophia_memories set lifecycle='tombstoned' where memory_id='10000000-0000-4000-8000-000000000001'`);
  const onlySaved=await read({view:'active'});assert.equal(onlySaved.total_count,803);checks++;
  await db.exec(`update sophia_memory_versions set canonical_content=null,content_ref=null,scrubbed_at=now()
    where memory_id='10000000-0000-4000-8000-000000000002' and content_revision=2`);
  changed=await read();assert.equal(changed.status,'unavailable');assert.equal(changed.total_count,null);assert.deepEqual(changed.records,[]);checks++;
  const scrubbedHit=await hits(['provider-10000000-0000-4000-8000-000000000002']);
  assert.equal(scrubbedHit.results[0].denial_reason,'unknown_status');assert.equal(scrubbedHit.results[0].memory,null);checks++;
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(read(),/permission denied/);
    await assert.rejects(hits([validId]),/permission denied/);await db.exec('reset role');checks++;}
  console.log(JSON.stringify({schema:'mem00.c1-inventory-sql.v1',passed:true,checks,pages,records:records.length,
    production_mutations:0,provider_calls:0,cleanup:'disposable database closed and synthetic transport removed',
    gateway_composed:Boolean(process.argv[3]),next_composed:Boolean(process.argv[4]),frontend_execution:frontendProof,
    scope:'Current-state exact-version inventory/export only; atomic clear, independent concurrency and release certification remain unproven'}));
}catch(error){console.error(JSON.stringify({schema:'mem00.c1-inventory-sql.v1',passed:false,checks_completed:checks,
  reason:String(error.message).replaceAll('\n',' | ').slice(-5000),production_mutations:0}));process.exitCode=1;}
finally{await db.close();}
