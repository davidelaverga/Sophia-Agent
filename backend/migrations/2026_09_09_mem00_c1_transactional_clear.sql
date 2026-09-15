-- Eighth C1 migration, STAGED / UNAPPROVED. Not exposed to application roles.
-- Atomic fence/scrub foundation. Epoch-aware new user actions, source
-- continuation, API/UI recovery and independent races must be composed before
-- the ordinary memory-clear endpoint can be enabled. No provider calls.
BEGIN;
ALTER TABLE public.sophia_memory_user_governance
  ADD COLUMN IF NOT EXISTS memory_clear_epoch bigint NOT NULL DEFAULT 0 CHECK(memory_clear_epoch>=0);
ALTER TABLE public.sophia_memory_extraction_runs
  ADD COLUMN IF NOT EXISTS memory_clear_epoch bigint NOT NULL DEFAULT 0 CHECK(memory_clear_epoch>=0);
ALTER TABLE public.sophia_memory_governance_events
  ADD COLUMN IF NOT EXISTS memory_clear_receipt jsonb,
  ADD COLUMN IF NOT EXISTS source_decision_epoch bigint NOT NULL DEFAULT 0 CHECK(source_decision_epoch>=0);
ALTER TABLE public.sophia_session_messages
  ADD COLUMN IF NOT EXISTS memory_source_acceptance_epoch bigint NOT NULL DEFAULT 0 CHECK(memory_source_acceptance_epoch>=0);

-- Existing and old-signature source writers retain epoch zero, including a
-- late transcript flush. Their source text is preserved, but cannot become new
-- post-clear extraction input. A future fixed epoch-aware source RPC must stamp
-- only new source occurrences from explicit new actions; updates cannot promote
-- an older occurrence into a newer epoch. No GUC/caller payload is authority.
CREATE OR REPLACE FUNCTION public.sophia_memory_source_acceptance_epoch_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND NEW.memory_source_acceptance_epoch IS DISTINCT FROM OLD.memory_source_acceptance_epoch THEN
    RAISE EXCEPTION 'memory_source_acceptance_epoch_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND NEW.memory_source_acceptance_epoch<>0
    AND current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid=TG_RELID) THEN
    RAISE EXCEPTION 'memory_source_acceptance_epoch_server_owned' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_source_acceptance_epoch ON public.sophia_session_messages;
CREATE TRIGGER sophia_memory_source_acceptance_epoch BEFORE INSERT OR UPDATE ON public.sophia_session_messages
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_source_acceptance_epoch_trigger();

CREATE OR REPLACE FUNCTION public.sophia_memory_clear_durability_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_TABLE_NAME='sophia_memory_user_governance' THEN
    IF NEW.memory_clear_epoch<OLD.memory_clear_epoch THEN
      RAISE EXCEPTION 'memory_clear_epoch_rollback_denied' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME='sophia_memory_extraction_runs' THEN
    IF NEW.memory_clear_epoch IS DISTINCT FROM OLD.memory_clear_epoch THEN
      RAISE EXCEPTION 'memory_extraction_clear_epoch_immutable' USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='INSERT' THEN
    IF NEW.event_type IN ('candidate_rejected','memory_tombstoned') THEN
      NEW.source_decision_epoch:=(SELECT memory_clear_epoch FROM public.sophia_memory_user_governance WHERE user_id=NEW.user_id);
    END IF;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.event_type='memory_cleared' THEN RAISE EXCEPTION 'memory_clear_receipt_immutable' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  ELSIF OLD.event_type='memory_cleared' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'memory_clear_receipt_immutable' USING ERRCODE='23514';
  ELSIF OLD.event_type IN ('candidate_rejected','memory_tombstoned') AND NEW.source_decision_epoch IS DISTINCT FROM OLD.source_decision_epoch THEN
    RAISE EXCEPTION 'memory_source_decision_epoch_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_clear_epoch_durable ON public.sophia_memory_user_governance;
CREATE TRIGGER sophia_memory_clear_epoch_durable BEFORE UPDATE ON public.sophia_memory_user_governance
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_clear_durability_trigger();
DROP TRIGGER IF EXISTS sophia_memory_extraction_clear_epoch_durable ON public.sophia_memory_extraction_runs;
CREATE TRIGGER sophia_memory_extraction_clear_epoch_durable BEFORE UPDATE ON public.sophia_memory_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_clear_durability_trigger();
DROP TRIGGER IF EXISTS sophia_memory_clear_receipt_durable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_clear_receipt_durable BEFORE INSERT OR UPDATE OR DELETE ON public.sophia_memory_governance_events
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_clear_durability_trigger();

-- Fixed legacy signatures cannot authorize new work after a clear. Their
-- already-committed receipts stay receipt-first. New epoch-aware signatures
-- must bind explicit user actions before these holds can be lifted.
DO $migration$
DECLARE definition text; marker text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_run_source_valid';
  marker:='AND m.memory_source_version=(d->>''source_version'')::uuid';
  IF position('-- MEM00_C1_CLEAR_SOURCE_OCCURRENCE' IN definition)=0 THEN
    IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'memory_clear_source_occurrence_baseline_mismatch'; END IF;
    EXECUTE replace(definition,marker,marker||E'\n      -- MEM00_C1_CLEAR_SOURCE_OCCURRENCE\n      AND m.memory_source_acceptance_epoch=(SELECT memory_clear_epoch FROM public.sophia_memory_user_governance WHERE user_id=p_user_id)');
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_manual_create';
  marker:='governance := public.sophia_memory_ensure_governance(p_user_id);';
  IF position('-- MEM00_C1_CLEAR_MANUAL_FENCE' IN definition)=0 THEN
    IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'memory_clear_manual_baseline_mismatch'; END IF;
    EXECUTE replace(definition,marker,marker||E'\n    -- MEM00_C1_CLEAR_MANUAL_FENCE\n    IF governance.memory_clear_epoch<>0 THEN RAISE EXCEPTION ''memory_clear_epoch_required'' USING ERRCODE=''40001''; END IF;');
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_apply_source_target';
  marker:='SELECT * INTO STRICT parent FROM public.sophia_sessions';
  IF position('-- MEM00_C1_CLEAR_SOURCE_FENCE' IN definition)=0 THEN
    IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'memory_clear_source_baseline_mismatch'; END IF;
    EXECUTE replace(definition,marker,E'-- MEM00_C1_CLEAR_SOURCE_FENCE\n  IF (SELECT memory_clear_epoch FROM public.sophia_memory_user_governance WHERE user_id=p_user_id)<>0 THEN RAISE EXCEPTION ''memory_clear_epoch_required'' USING ERRCODE=''40001''; END IF;\n  '||marker);
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_complete_extraction';
  marker:='PERFORM 1 FROM public.sophia_sessions';
  IF position('-- MEM00_C1_CLEAR_PUBLICATION_FENCE' IN definition)=0 THEN
    IF position(marker IN definition)=0 THEN RAISE EXCEPTION 'memory_clear_publication_baseline_mismatch'; END IF;
    EXECUTE replace(definition,marker,E'-- MEM00_C1_CLEAR_PUBLICATION_FENCE\n  IF run.memory_clear_epoch IS DISTINCT FROM (SELECT memory_clear_epoch FROM public.sophia_memory_user_governance WHERE user_id=p_user_id) THEN RAISE EXCEPTION ''memory_clear_epoch_stale'' USING ERRCODE=''40001''; END IF;\n  '||marker);
  END IF;
END $migration$;

-- Ignore an older epoch's decision only when every exact input occurrence is
-- proved current-epoch source. A late old-writer flush is epoch zero and fails
-- this check. Within an epoch, unknown/overlapping decisions still fail closed.
CREATE OR REPLACE FUNCTION public.sophia_memory_source_decision_overlaps(p_owner text,p_session text,p_dependencies jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE event record; witness jsonb; current_epoch bigint;
BEGIN
  IF jsonb_typeof(p_dependencies) IS DISTINCT FROM 'array' OR jsonb_array_length(p_dependencies)=0 THEN RETURN true; END IF;
  SELECT memory_clear_epoch INTO current_epoch FROM public.sophia_memory_user_governance WHERE user_id=p_owner;
  IF current_epoch IS NULL THEN RETURN true; END IF;
  IF current_epoch>0 AND NOT public.sophia_memory_run_source_valid(p_owner,p_session,
    (SELECT min((d->>'sequence')::bigint) FROM jsonb_array_elements(p_dependencies)d),
    (SELECT max((d->>'sequence')::bigint) FROM jsonb_array_elements(p_dependencies)d),p_dependencies) THEN RETURN true; END IF;
  FOR event IN SELECT source_decision_witnesses FROM public.sophia_memory_governance_events
    WHERE user_id=p_owner AND event_type IN ('candidate_rejected','memory_tombstoned') AND source_decision_epoch>=current_epoch LOOP
    IF jsonb_typeof(event.source_decision_witnesses) IS DISTINCT FROM 'array' THEN RETURN true; END IF;
    FOR witness IN SELECT value FROM jsonb_array_elements(event.source_decision_witnesses) LOOP
      IF witness->>'session_id' IS NULL THEN RETURN true; END IF;
      IF witness->>'session_id'<>p_session THEN CONTINUE; END IF;
      IF jsonb_typeof(witness->'dependencies') IS DISTINCT FROM 'array' THEN RETURN true; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(witness->'dependencies') old_source
        JOIN jsonb_array_elements(p_dependencies) new_source ON old_source->>'message_id'=new_source->>'message_id'
          AND old_source->>'sequence'=new_source->>'sequence' AND old_source->>'source_version'=new_source->>'source_version') THEN RETURN true; END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_source_decision_overlaps(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Explicit post-boundary manual consent is a different command. Do not make
-- the legacy signature silently read a fresh epoch and revive an old request.
-- This fixed wrapper is still operator-only until API/UI CAS capture is wired.
DO $migration$
DECLARE definition text; guard text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
    WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_manual_create';
  guard:='IF governance.memory_clear_epoch<>0 THEN RAISE EXCEPTION ''memory_clear_epoch_required'' USING ERRCODE=''40001''; END IF;';
  IF position(guard IN definition)=0 THEN RAISE EXCEPTION 'memory_clear_manual_epoch_baseline_mismatch'; END IF;
  EXECUTE replace(replace(definition,'public.sophia_memory_manual_create(',
    'public.sophia_memory_manual_create_epoch_core('),guard,'');
END $migration$;
CREATE OR REPLACE FUNCTION public.sophia_memory_manual_create_at_epoch(
  p_user_id text,p_canonical_content text,p_content_ref text,p_category text,p_scope text,p_user_tier text,
  p_actor_kind text,p_idempotency_key text,p_request_digest text,p_provider text,p_environment text,p_provider_project text,
  p_expected_clear_epoch bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance;
BEGIN
  IF p_expected_clear_epoch IS NULL OR p_expected_clear_epoch<0 THEN
    RAISE EXCEPTION 'memory_clear_epoch_invalid' USING ERRCODE='22023';
  END IF;
  IF p_actor_kind IS DISTINCT FROM 'user' OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
    OR p_request_digest IS NULL OR length(p_request_digest) NOT BETWEEN 8 AND 512 THEN
    RAISE EXCEPTION 'memory_clear_command_invalid' USING ERRCODE='22023';
  END IF;
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  IF NOT EXISTS(SELECT 1 FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key)
    AND p_expected_clear_epoch IS DISTINCT FROM governance.memory_clear_epoch THEN
    RAISE EXCEPTION 'memory_clear_epoch_stale' USING ERRCODE='40001';
  END IF;
  RETURN public.sophia_memory_manual_create_epoch_core(p_user_id,p_canonical_content,p_content_ref,p_category,p_scope,p_user_tier,
    p_actor_kind,p_idempotency_key,p_request_digest||':clear-epoch:'||p_expected_clear_epoch::text,p_provider,p_environment,p_provider_project);
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_clear(
  p_user_id text,p_actor_kind text,p_idempotency_key text,p_request_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; previous public.sophia_memory_governance_events;
  item record; operation uuid:=gen_random_uuid(); accepted_at timestamptz;
  memory_count bigint; pending_count bigint; version_count bigint; candidate_version_count bigint;
  run_count bigint; receipt jsonb;
BEGIN
  IF p_actor_kind IS DISTINCT FROM 'user' OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200
    OR p_request_digest IS NULL OR length(p_request_digest) NOT BETWEEN 8 AND 512 THEN
    RAISE EXCEPTION 'memory_clear_command_invalid' USING ERRCODE='22023';
  END IF;
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO previous FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF previous.event_type<>'memory_cleared' OR previous.request_digest<>p_request_digest OR previous.memory_clear_receipt IS NULL THEN
      RAISE EXCEPTION 'memory_idempotency_digest_conflict' USING ERRCODE='23505';
    END IF;
    RETURN previous.memory_clear_receipt||jsonb_build_object('idempotent_replay',true);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1'
    AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced')) THEN
    RAISE EXCEPTION 'memory_clear_contract_unavailable';
  END IF;
  accepted_at:=clock_timestamp();
  SELECT count(*) INTO memory_count FROM public.sophia_memories WHERE user_id=p_user_id AND lifecycle<>'tombstoned';
  SELECT count(*) INTO pending_count FROM public.sophia_memory_candidates WHERE user_id=p_user_id AND review_state='pending_review';
  SELECT count(*) INTO version_count FROM public.sophia_memory_versions WHERE user_id=p_user_id AND canonical_content IS NOT NULL;
  SELECT count(*) INTO candidate_version_count FROM public.sophia_memory_candidate_versions WHERE user_id=p_user_id AND proposed_content IS NOT NULL;
  -- No capped inventory and no intermediate commit. A timeout/crash rolls the
  -- complete operation back; no partial accepted-and-fenced receipt escapes.
  FOR item IN SELECT memory_id,memory_governance_revision FROM public.sophia_memories
    WHERE user_id=p_user_id AND lifecycle<>'tombstoned' ORDER BY memory_id LOOP
    PERFORM public.sophia_memory_tombstone(p_user_id,item.memory_id,item.memory_governance_revision,p_actor_kind,
      'clear-'||operation||':memory:'||item.memory_id,'mem00-clear-child:'||operation||':memory:'||item.memory_id);
  END LOOP;
  FOR item IN SELECT candidate_id,current_candidate_revision FROM public.sophia_memory_candidates
    WHERE user_id=p_user_id AND review_state='pending_review' ORDER BY candidate_id LOOP
    PERFORM public.sophia_memory_reject_candidate(p_user_id,item.candidate_id,item.current_candidate_revision,p_actor_kind,
      'clear-'||operation||':candidate:'||item.candidate_id,'mem00-clear-child:'||operation||':candidate:'||item.candidate_id);
  END LOOP;
  UPDATE public.sophia_memory_versions SET canonical_content=NULL,content_ref=NULL,scrubbed_at=coalesce(scrubbed_at,now())
    WHERE user_id=p_user_id AND (canonical_content IS NOT NULL OR content_ref IS NOT NULL OR scrubbed_at IS NULL);
  UPDATE public.sophia_memory_candidate_versions SET proposed_content=NULL,content_ref=NULL,scrubbed_at=coalesce(scrubbed_at,now())
    WHERE user_id=p_user_id AND (proposed_content IS NOT NULL OR content_ref IS NOT NULL OR scrubbed_at IS NULL);
  UPDATE public.sophia_memory_extraction_runs SET state='superseded',safe_terminal_reason='memory_clear_accepted',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,terminal_at=coalesce(terminal_at,now()),updated_at=now()
    WHERE user_id=p_user_id AND state IN ('queued','leased','retry_wait','failed_terminal');
  GET DIAGNOSTICS run_count=ROW_COUNT;
  -- The owner lock has been held throughout. Child source decisions belong to
  -- the old epoch; publish the new boundary only after they have been captured.
  UPDATE public.sophia_memory_user_governance SET memory_clear_epoch=memory_clear_epoch+1,
    user_catalog_generation=user_catalog_generation+1,user_revocation_epoch=user_revocation_epoch+1,updated_at=now()
    WHERE user_id=p_user_id RETURNING * INTO governance;
  receipt:=jsonb_build_object('schema','mem00.clear-command.v1','owner_id',p_user_id,'command_key',p_idempotency_key,
    'operation_id','memop-'||replace(operation::text,'-',''),'event_id',operation,'status','accepted_and_fenced',
    'accepted_at',accepted_at,'memory_clear_epoch',governance.memory_clear_epoch,
    'user_catalog_generation',governance.user_catalog_generation,'user_revocation_epoch',governance.user_revocation_epoch,
    'historical_result_only',true,'idempotent_replay',false,
    'scope',jsonb_build_object('kind','existing_memory_and_pre_boundary_work','canonical_memories',memory_count,
      'pending_candidates',pending_count,'fenced_extraction_runs',run_count),
    'disposition',jsonb_build_object('canonical_fence','committed','canonical_plaintext_scrub','committed',
      'candidate_plaintext_scrub','committed','canonical_versions_scrubbed',version_count,'candidate_versions_scrubbed',candidate_version_count,
      'provider_cleanup','not_verified_in_this_response','derived_invalidation','not_verified_in_this_response',
      'managed_browser_erasure','not_verified_in_this_response','source_transcript','not_deleted',
      'independent_documents','not_deleted','other_account_data','not_covered_by_mem00'),
    'source_policy','pre_clear_occurrences_fenced_new_occurrences_require_epoch_witness',
    'post_clear_action_profile','legacy_writers_fenced_epoch_aware_app_not_enabled');
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,
    actor_kind,safe_reason_code,user_catalog_generation,user_revocation_epoch,memory_clear_receipt)
    VALUES(operation,receipt->>'operation_id',p_idempotency_key,p_request_digest,p_user_id,'memory_cleared',p_actor_kind,
      'atomic_memory_clear_accepted',governance.user_catalog_generation,governance.user_revocation_epoch,receipt);
  UPDATE public.sophia_memory_user_governance SET last_event_id=operation,last_event_at=now(),updated_at=now() WHERE user_id=p_user_id;
  RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_lookup_clear_receipt(p_user_id text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE receipt jsonb;
BEGIN
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'memory_clear_command_invalid' USING ERRCODE='22023';
  END IF;
  PERFORM g.user_id FROM public.sophia_memory_user_governance g JOIN public.sophia_memory_contract c
    ON c.singleton AND c.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed' AND g.authority_epoch=1
      AND c.schema_version='mem00.v1' AND c.mode IN ('shadow','enforced') FOR SHARE OF g;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_clear_authority_unavailable'; END IF;
  SELECT memory_clear_receipt INTO receipt FROM public.sophia_memory_governance_events
    WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key AND event_type='memory_cleared';
  RETURN jsonb_build_object('schema','mem00.clear-status.v1','owner_id',p_user_id,'command_key',p_idempotency_key,
    'status',CASE WHEN receipt IS NULL THEN 'not_found' ELSE 'committed' END,'historical_result_only',true,'receipt',receipt);
END $fn$;

-- Canonical mutations must enter fixed, audited RPCs. Direct table DML would
-- bypass the owner lock and clear/consent fences even with a service credential.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.sophia_memories,public.sophia_memory_versions,
  public.sophia_memory_candidates,public.sophia_memory_candidate_versions,public.sophia_memory_candidate_sources,
  public.sophia_memory_extraction_runs,public.sophia_memory_governance_events,public.sophia_memory_tombstones,
  public.sophia_memory_provider_bindings,public.sophia_memory_projection_jobs,public.sophia_memory_prompt_admissions
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_clear_durability_trigger(),public.sophia_memory_clear(text,text,text,text),
  public.sophia_memory_lookup_clear_receipt(text,text),public.sophia_memory_source_acceptance_epoch_trigger()
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_manual_create_epoch_core(text,text,text,text,text,text,text,text,text,text,text,text),
  public.sophia_memory_manual_create_at_epoch(text,text,text,text,text,text,text,text,text,text,text,text,bigint)
  FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
