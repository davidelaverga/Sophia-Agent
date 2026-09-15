-- MEM00 C2 selected final model/source authority. Unapplied; no serving grants.

-- Reuses reviewed C1 receipt carriers and current v4 request contract.

-- C2 excludes completion/resume admission and personal-memory Builder inheritance.

BEGIN;

-- Earlier receipts lack route provenance and cannot become final authority.
ALTER TABLE public.sophia_memory_prompt_admissions ADD COLUMN IF NOT EXISTS availability_context jsonb;
CREATE OR REPLACE FUNCTION public.sophia_memory_record_prompt_admission(
    p_retrieval_request_id UUID,
    p_user_id TEXT,
    p_caller TEXT,
    p_scope TEXT,
    p_query_ref TEXT,
    p_provider TEXT,
    p_environment TEXT,
    p_provider_project TEXT,
    p_provider_namespace TEXT,
    p_provider_status TEXT,
    p_provider_hit_count INTEGER,
    p_catalog_generation_checked BIGINT,
    p_revocation_epoch_checked BIGINT,
    p_authorized_manifest JSONB,
    p_denial_counts JSONB,
    p_outcome TEXT,
    p_safe_reason_code TEXT,
    p_latency_segments JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    manifest_item JSONB;
    admission_id UUID := gen_random_uuid();
BEGIN
    IF jsonb_typeof(p_authorized_manifest) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_authorized_manifest_invalid';
    END IF;
    SELECT * INTO STRICT governance
      FROM public.sophia_memory_user_governance
     WHERE user_id = p_user_id
     FOR SHARE;
    IF governance.user_catalog_generation <> p_catalog_generation_checked
       OR governance.user_revocation_epoch <> p_revocation_epoch_checked THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_prompt_governance_stale';
    END IF;

    FOR manifest_item IN SELECT value FROM jsonb_array_elements(p_authorized_manifest)
    LOOP
        IF NOT EXISTS (
            SELECT 1
              FROM public.sophia_memories memory
              JOIN public.sophia_memory_versions version
                ON version.user_id = memory.user_id
               AND version.memory_id = memory.memory_id
               AND version.content_revision = memory.current_content_revision
             WHERE memory.user_id = p_user_id
               AND memory.memory_id = (manifest_item->>'memory_id')::uuid
               AND memory.lifecycle = 'active'
               AND memory.current_content_revision = (manifest_item->>'content_revision')::bigint
               AND memory.memory_governance_revision = (manifest_item->>'memory_governance_revision')::bigint
               AND (version.scope = 'global' OR version.scope = p_scope)
               AND version.canonical_content IS NOT NULL
               AND version.content_ref IS NOT NULL
               AND NOT EXISTS (
                   SELECT 1 FROM public.sophia_memory_tombstones tombstone
                    WHERE tombstone.user_id = memory.user_id
                      AND tombstone.memory_id = memory.memory_id
               )
               AND EXISTS (
                   SELECT 1 FROM public.sophia_memory_provider_bindings binding
                    WHERE binding.user_id = memory.user_id
                      AND binding.memory_id = memory.memory_id
                      AND binding.provider = p_provider
                      AND binding.environment = p_environment
                      AND binding.provider_project = p_provider_project
                      AND binding.provider_namespace = p_provider_namespace
                      AND binding.canonical_content_revision = memory.current_content_revision
                      AND binding.memory_governance_revision = memory.memory_governance_revision
                      AND binding.binding_state = 'eligible'
                      AND binding.metadata_verification_state = 'verified'
               )
        ) THEN
            RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_prompt_admission_denied';
        END IF;
    END LOOP;

    INSERT INTO public.sophia_memory_prompt_admissions(
        prompt_admission_id, retrieval_request_id, user_id, caller, scope,
        query_ref, provider_status, provider_hit_count,
        catalog_generation_checked, revocation_epoch_checked,
        authorized_manifest, denial_counts, outcome, safe_reason_code,
        latency_segments, availability_context
    ) VALUES (
        admission_id, p_retrieval_request_id, p_user_id, p_caller, p_scope,
        p_query_ref, p_provider_status, p_provider_hit_count,
        p_catalog_generation_checked, p_revocation_epoch_checked,
        p_authorized_manifest, coalesce(p_denial_counts, '{}'::jsonb),
        p_outcome, p_safe_reason_code, coalesce(p_latency_segments, '{}'::jsonb),
        jsonb_build_object('provider',p_provider,'environment',p_environment,
            'provider_project',p_provider_project,'provider_namespace',p_provider_namespace)
    );
    RETURN admission_id;
END
$function$;
REVOKE ALL ON FUNCTION public.sophia_memory_record_prompt_admission(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BIGINT,BIGINT,JSONB,JSONB,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.sophia_memory_governance_events ADD COLUMN IF NOT EXISTS model_dispatch_receipt jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_model_dispatch_attempt
  ON public.sophia_memory_governance_events((model_dispatch_receipt->>'attempt_id')) WHERE model_dispatch_receipt IS NOT NULL;
CREATE OR REPLACE FUNCTION public.sophia_memory_model_dispatch_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.model_dispatch_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'memory_model_dispatch_receipt_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_model_dispatch_immutable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_model_dispatch_immutable BEFORE UPDATE OR DELETE ON public.sophia_memory_governance_events
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_model_dispatch_immutable();



ALTER TABLE public.sophia_memory_governance_events ADD COLUMN IF NOT EXISTS builder_source_receipt jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_builder_handoff_child
 ON public.sophia_memory_governance_events(user_id,(builder_source_receipt->>'child_thread_id'))
 WHERE builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1';
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_builder_bound_handoff
 ON public.sophia_memory_governance_events((builder_source_receipt->>'handoff_event_id'))
 WHERE builder_source_receipt->>'schema'='mem00.builder-source-run.v1';
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_builder_bound_run
 ON public.sophia_memory_governance_events((builder_source_receipt->>'child_run_id'))
 WHERE builder_source_receipt->>'schema'='mem00.builder-source-run.v1';
CREATE OR REPLACE FUNCTION public.sophia_memory_builder_source_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
 IF OLD.builder_source_receipt IS NOT NULL THEN
  RAISE EXCEPTION 'memory_builder_source_receipt_immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_builder_source_immutable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_builder_source_immutable BEFORE UPDATE OR DELETE ON public.sophia_memory_governance_events
 FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_builder_source_immutable();

CREATE OR REPLACE FUNCTION public.sophia_memory_assert_recorded_model_sources(
 p_user_id text,p_sources jsonb,p_epoch bigint,p_thread_id text,p_allow_ended boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance;parent public.sophia_sessions;
 source_row public.sophia_session_messages;witness jsonb;original jsonb;expected_witness jsonb;
BEGIN
 governance:=public.sophia_memory_ensure_governance(p_user_id);
 PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1'
  AND contract_epoch=1 AND mode='enforced' FOR SHARE;
 IF NOT FOUND OR governance.authority_state IS DISTINCT FROM 'governed' OR governance.authority_epoch IS DISTINCT FROM 1
  OR governance.memory_clear_epoch IS DISTINCT FROM p_epoch THEN
  RAISE EXCEPTION 'memory_builder_source_governance_changed' USING ERRCODE='40001';
 END IF;
 IF jsonb_typeof(p_sources) IS DISTINCT FROM 'array' OR octet_length(p_sources::text)>262144 THEN
  RAISE EXCEPTION 'memory_builder_sources_invalid' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_sources) NOT BETWEEN 1 AND 128
  OR jsonb_array_length(p_sources)<>(SELECT count(DISTINCT (x->>'session_id',x->>'source_row_id')) FROM jsonb_array_elements(p_sources) x)
  OR jsonb_array_length(p_sources)<>(SELECT count(DISTINCT x->>'event_id') FROM jsonb_array_elements(p_sources) x) THEN
  RAISE EXCEPTION 'memory_builder_sources_invalid' USING ERRCODE='22023';
 END IF;
  FOR witness IN SELECT value FROM jsonb_array_elements(p_sources)
    ORDER BY value->>'session_id',value->>'source_row_id'
  LOOP
  SELECT source_intake_receipt INTO original FROM public.sophia_memory_governance_events
    WHERE user_id=p_user_id AND source_intake_receipt->>'command_key'=witness->>'command_key';
  IF original IS NULL THEN RAISE EXCEPTION 'memory_model_source_unavailable' USING ERRCODE='40001'; END IF;
  SELECT jsonb_object_agg(key,value) INTO expected_witness FROM jsonb_each(original) WHERE key=ANY(ARRAY[
    'owner_id','session_id','thread_id','command_key','event_id','message_id','source_row_id','source_version','sequence','memory_clear_epoch','content_ref']);
  expected_witness:=expected_witness||jsonb_build_object('schema','mem00.recorded-input-source.v1');
  IF witness IS DISTINCT FROM expected_witness OR witness->>'owner_id' IS DISTINCT FROM p_user_id
    OR (p_thread_id IS NOT NULL AND witness->>'thread_id' IS DISTINCT FROM p_thread_id)
    OR (witness->>'memory_clear_epoch')::bigint IS DISTINCT FROM governance.memory_clear_epoch THEN
    RAISE EXCEPTION 'memory_model_source_changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=witness->>'session_id' FOR SHARE;
  IF NOT FOUND OR parent.thread_id IS DISTINCT FROM witness->>'thread_id' OR parent.status IS NULL
    OR (parent.status NOT IN ('active','resumable') AND NOT (p_allow_ended IS TRUE AND parent.status='ended')) OR coalesce(parent.metadata,'{}')?'synthetic_voice_lab'
    OR public.sophia_memory_source_fenced(p_user_id,parent.id) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'memory_model_source_unavailable' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source_row FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=parent.id
    AND id=witness->>'source_row_id' AND message_id=witness->>'message_id' FOR SHARE;
  IF NOT FOUND OR source_row.thread_id IS DISTINCT FROM parent.thread_id OR source_row.role IS DISTINCT FROM 'user'
    OR source_row.final IS DISTINCT FROM true OR nullif(btrim(source_row.content),'') IS NULL
    OR source_row.sequence IS DISTINCT FROM (witness->>'sequence')::bigint
    OR source_row.memory_source_version::text IS DISTINCT FROM witness->>'source_version'
    OR source_row.memory_source_acceptance_epoch IS DISTINCT FROM governance.memory_clear_epoch
    OR (source_row.memory_source_accepted_version IS DISTINCT FROM source_row.memory_source_version
      AND NOT(governance.memory_clear_epoch=0 AND source_row.memory_source_accepted_version IS NULL)) THEN
    RAISE EXCEPTION 'memory_model_source_changed' USING ERRCODE='40001';
  END IF;
  END LOOP;

END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_get_builder_handoff(p_user_id text,p_child_thread_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT builder_source_receipt FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1'
 AND builder_source_receipt->>'child_thread_id'=p_child_thread_id::text
$fn$;
CREATE OR REPLACE FUNCTION public.sophia_memory_get_builder_source_run(p_user_id text,p_binding_event_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT builder_source_receipt FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND event_id=p_binding_event_id AND builder_source_receipt->>'schema'='mem00.builder-source-run.v1'
$fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_register_builder_handoff(p_user_id text,p_handoff jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance;prior public.sophia_memory_prompt_admissions;
 previous jsonb;receipt jsonb;event uuid:=gen_random_uuid();child uuid;keys text[];
BEGIN
 IF jsonb_typeof(p_handoff) IS DISTINCT FROM 'object' OR octet_length(p_handoff::text)>262144 THEN
  RAISE EXCEPTION 'memory_builder_handoff_invalid' USING ERRCODE='22023';
 END IF;
 SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(p_handoff) key;
 IF keys IS DISTINCT FROM ARRAY['catalog_generation','child_thread_id','contract_epoch','initial_memory_manifest','parent_run_id','parent_thread_id',
  'payload_ref','prior_admission_id','revocation_epoch','schema','scope','source_dependencies']::text[]
  OR p_handoff->'initial_memory_manifest' IS DISTINCT FROM '[]'::jsonb
  OR p_handoff->>'schema' IS DISTINCT FROM 'mem00.builder-source-handoff.v1' OR p_handoff->'contract_epoch' IS DISTINCT FROM '1'::jsonb
  OR p_handoff->>'payload_ref' IS NULL OR p_handoff->>'payload_ref' !~ '^hmac-sha256:checkpoint-state:[a-f0-9]{64}$'
  OR p_handoff->>'scope' IS NULL OR p_handoff->>'scope' NOT IN ('global','life','work','gaming')
  OR jsonb_typeof(p_handoff->'catalog_generation') IS DISTINCT FROM 'number' OR p_handoff->>'catalog_generation' !~ '^[0-9]+$'
  OR jsonb_typeof(p_handoff->'revocation_epoch') IS DISTINCT FROM 'number' OR p_handoff->>'revocation_epoch' !~ '^[0-9]+$' THEN
  RAISE EXCEPTION 'memory_builder_handoff_invalid' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['parent_run_id','parent_thread_id','child_thread_id','prior_admission_id']) key
  WHERE jsonb_typeof(p_handoff->key) IS DISTINCT FROM 'string' OR p_handoff->>key IS NULL) THEN
  RAISE EXCEPTION 'memory_builder_handoff_invalid' USING ERRCODE='22023';
 END IF;
 child:=(p_handoff->>'child_thread_id')::uuid;
 PERFORM (p_handoff->>'parent_run_id')::uuid,(p_handoff->>'parent_thread_id')::uuid,(p_handoff->>'prior_admission_id')::uuid;
 IF child::text=p_handoff->>'parent_thread_id' THEN RAISE EXCEPTION 'memory_builder_self_handoff' USING ERRCODE='22023'; END IF;
 governance:=public.sophia_memory_ensure_governance(p_user_id);
 previous:=public.sophia_memory_get_builder_handoff(p_user_id,child);
 -- Exact receipt recovery precedes current lifecycle checks. It is not admission.
 IF previous IS NOT NULL THEN
  IF previous->'request' IS DISTINCT FROM p_handoff THEN
   RAISE EXCEPTION 'memory_builder_handoff_conflict' USING ERRCODE='23505';
  END IF;
  RETURN previous;
 END IF;
 PERFORM public.sophia_memory_assert_recorded_model_sources(p_user_id,p_handoff->'source_dependencies',
  governance.memory_clear_epoch,p_handoff->>'parent_thread_id',false);
 SELECT * INTO prior FROM public.sophia_memory_prompt_admissions
 WHERE user_id=p_user_id AND prompt_admission_id=(p_handoff->>'prior_admission_id')::uuid;
 IF NOT FOUND OR prior.provider_status IS DISTINCT FROM 'ok' OR prior.scope IS DISTINCT FROM p_handoff->>'scope'
  OR prior.availability_context IS NULL OR prior.outcome NOT IN ('authorized','zero_memory')
  OR prior.authorized_manifest IS DISTINCT FROM p_handoff->'initial_memory_manifest'
  OR prior.created_at>clock_timestamp() OR prior.created_at<clock_timestamp()-interval '5 seconds'
  OR prior.catalog_generation_checked IS DISTINCT FROM governance.user_catalog_generation
  OR prior.revocation_epoch_checked IS DISTINCT FROM governance.user_revocation_epoch
  OR governance.user_catalog_generation IS DISTINCT FROM (p_handoff->>'catalog_generation')::bigint
  OR governance.user_revocation_epoch IS DISTINCT FROM (p_handoff->>'revocation_epoch')::bigint THEN
  RAISE EXCEPTION 'memory_builder_parent_admission_stale' USING ERRCODE='40001';
 END IF;
 receipt:=jsonb_build_object('schema','mem00.builder-source-handoff-receipt.v1','event_id',event,'owner_id',p_user_id,
  'child_thread_id',child,'request',p_handoff,'memory_clear_epoch',governance.memory_clear_epoch,
  'initial_memory_manifest',prior.authorized_manifest,'accepted_at',clock_timestamp(),'historical_result_only',true);
 INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,
  safe_reason_code,user_catalog_generation,user_revocation_epoch,builder_source_receipt)
 VALUES(event,child::text,'builder-source-handoff:'||child::text,p_handoff->>'payload_ref',p_user_id,'builder_source_handoff_recorded','system',
  'historical_source_association',governance.user_catalog_generation,governance.user_revocation_epoch,receipt);
 RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_bind_builder_source_run(
 p_user_id text,p_handoff_event_id uuid,p_child_thread_id uuid,p_child_run_id uuid,p_payload_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance;handoff jsonb;previous jsonb;receipt jsonb;event uuid:=gen_random_uuid();
BEGIN
 IF p_handoff_event_id IS NULL OR p_child_thread_id IS NULL OR p_child_run_id IS NULL OR p_payload_ref IS NULL
  OR p_payload_ref !~ '^hmac-sha256:checkpoint-state:[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'memory_builder_run_binding_invalid' USING ERRCODE='22023';
 END IF;
 governance:=public.sophia_memory_ensure_governance(p_user_id);
 SELECT builder_source_receipt INTO handoff FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND event_id=p_handoff_event_id AND builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1';
 IF handoff IS NULL OR handoff->>'child_thread_id' IS DISTINCT FROM p_child_thread_id::text
  OR handoff->'request'->>'payload_ref' IS DISTINCT FROM p_payload_ref THEN
  RAISE EXCEPTION 'memory_builder_handoff_unproven' USING ERRCODE='40001';
 END IF;
 SELECT builder_source_receipt INTO previous FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND builder_source_receipt->>'schema'='mem00.builder-source-run.v1'
 AND builder_source_receipt->>'handoff_event_id'=p_handoff_event_id::text;
 IF previous IS NOT NULL THEN
  IF previous->>'child_run_id' IS DISTINCT FROM p_child_run_id::text THEN
   RAISE EXCEPTION 'memory_builder_run_already_bound' USING ERRCODE='23505';
  END IF;
  RETURN previous;
 END IF;
 PERFORM public.sophia_memory_assert_recorded_model_sources(p_user_id,handoff->'request'->'source_dependencies',
  (handoff->>'memory_clear_epoch')::bigint,handoff->'request'->>'parent_thread_id',true);
 receipt:=jsonb_build_object('schema','mem00.builder-source-run.v1','binding_event_id',event,'handoff_event_id',p_handoff_event_id,
  'owner_id',p_user_id,'parent_thread_id',handoff->'request'->>'parent_thread_id','parent_run_id',handoff->'request'->>'parent_run_id',
  'child_thread_id',p_child_thread_id,'child_run_id',p_child_run_id,'payload_ref',p_payload_ref,
  'source_dependencies',handoff->'request'->'source_dependencies','memory_clear_epoch',handoff->'memory_clear_epoch',
  'initial_memory_manifest',handoff->'initial_memory_manifest','accepted_at',clock_timestamp(),'historical_result_only',true);
 INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,
  safe_reason_code,user_catalog_generation,user_revocation_epoch,builder_source_receipt)
 VALUES(event,p_child_run_id::text,'builder-source-run:'||p_child_run_id::text,p_payload_ref,p_user_id,'builder_source_run_bound','system',
  'historical_source_association',governance.user_catalog_generation,governance.user_revocation_epoch,receipt);
 RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_get_builder_source_run_for_handoff(p_user_id text,p_handoff_event_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT builder_source_receipt FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND builder_source_receipt->>'schema'='mem00.builder-source-run.v1'
 AND builder_source_receipt->>'handoff_event_id'=p_handoff_event_id::text
$fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_builder_source_immutable(),
 public.sophia_memory_assert_recorded_model_sources(text,jsonb,bigint,text,boolean),
 public.sophia_memory_get_builder_handoff(text,uuid),public.sophia_memory_get_builder_source_run(text,uuid),
 public.sophia_memory_register_builder_handoff(text,jsonb),
 public.sophia_memory_get_builder_source_run_for_handoff(text,uuid),
 public.sophia_memory_bind_builder_source_run(text,uuid,uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sophia_memory_authorize_legacy_model_dispatch(p_user_id text,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; keys text[];
  attempt_id uuid; run_id uuid; thread_id uuid; event_id uuid:=gen_random_uuid();
  accepted timestamptz; receipt jsonb;
BEGIN
  IF p_user_id IS NULL OR nullif(btrim(p_user_id),'') IS NULL OR p_user_id<>btrim(p_user_id)
    OR p_attempt IS NULL OR jsonb_typeof(p_attempt)<>'object' OR octet_length(p_attempt::text)>8192 THEN
    RAISE EXCEPTION 'memory_legacy_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(p_attempt) key;
  IF keys IS DISTINCT FROM ARRAY['attempt_id','contract_epoch','endpoint_ref','model_ref','payload_ref','run_id','schema','scope','thread_id']::text[]
    OR p_attempt->>'schema' IS DISTINCT FROM 'mem00.legacy-model-attempt.v1'
    OR p_attempt->'contract_epoch' IS DISTINCT FROM '1'::jsonb
    OR p_attempt->>'payload_ref' IS NULL OR p_attempt->>'payload_ref' !~ '^hmac-sha256:model-payload:[a-f0-9]{64}$'
    OR p_attempt->>'endpoint_ref' IS NULL OR p_attempt->>'endpoint_ref' !~ '^hmac-sha256:model-endpoint:[a-f0-9]{64}$'
    OR p_attempt->>'model_ref' IS NULL OR p_attempt->>'model_ref' !~ '^hmac-sha256:model-route:[a-f0-9]{64}$'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['attempt_id','run_id','thread_id','scope']) key
      WHERE jsonb_typeof(p_attempt->key) IS DISTINCT FROM 'string' OR nullif(btrim(p_attempt->>key),'') IS NULL
        OR p_attempt->>key<>btrim(p_attempt->>key) OR length(p_attempt->>key)>512) THEN
    RAISE EXCEPTION 'memory_legacy_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  attempt_id:=(p_attempt->>'attempt_id')::uuid;
  run_id:=(p_attempt->>'run_id')::uuid;
  thread_id:=(p_attempt->>'thread_id')::uuid;
  SELECT * INTO governance FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR governance.authority_state IS DISTINCT FROM 'legacy'
    OR governance.authority_epoch IS DISTINCT FROM 1 OR governance.authority_declared_at IS NULL
    OR governance.user_catalog_generation<>0 OR governance.user_revocation_epoch<>0
    OR governance.memory_clear_epoch<>0 THEN
    RAISE EXCEPTION 'memory_legacy_model_authority_denied' USING ERRCODE='40001';
  END IF;
  PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1'
    AND contract_epoch=1 AND mode IN ('shadow','enforced') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_legacy_model_contract_denied' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM public.sophia_memory_governance_events
    WHERE model_dispatch_receipt->>'attempt_id'=attempt_id::text) THEN
    RAISE EXCEPTION 'memory_model_attempt_consumed' USING ERRCODE='40001';
  END IF;
  accepted:=clock_timestamp();
  receipt:=jsonb_build_object('schema','mem00.legacy-model-dispatch.v1','owner_id',p_user_id,
    'attempt_id',attempt_id,'run_id',run_id,'thread_id',thread_id,'scope',p_attempt->>'scope',
    'contract_epoch',1,'event_id',event_id,'payload_ref',p_attempt->>'payload_ref',
    'endpoint_ref',p_attempt->>'endpoint_ref','model_ref',p_attempt->>'model_ref',
    'authority_state','legacy','canonical_approval_granted',false,
    'accepted_at',accepted,'expires_at',accepted+interval '5 seconds','single_use',true,'dispatch_observed',false);
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,
    event_type,actor_kind,safe_reason_code,user_catalog_generation,user_revocation_epoch,model_dispatch_receipt)
  VALUES(event_id,attempt_id::text,'legacy-model-dispatch:'||attempt_id::text,p_attempt->>'payload_ref',p_user_id,
    'legacy_model_dispatch_authorized','system','declared_pre_cutover_model_admitted',0,0,receipt);
  RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_authorize_legacy_model_dispatch(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sophia_memory_check_source_use(p_user_id text,p_current_source jsonb,p_sources jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance;parent public.sophia_sessions;
 source_row public.sophia_session_messages;witness jsonb;original jsonb;expected_witness jsonb;source_epoch bigint;
BEGIN
 IF jsonb_typeof(p_current_source) IS DISTINCT FROM 'object' OR octet_length(p_current_source::text)>8192
  OR jsonb_typeof(p_sources) IS DISTINCT FROM 'array' OR octet_length(p_sources::text)>262144 THEN
  RAISE EXCEPTION 'memory_source_use_invalid' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_sources) NOT BETWEEN 1 AND 128
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources) x WHERE x=p_current_source)
  OR jsonb_array_length(p_sources)<>(SELECT count(DISTINCT (x->>'session_id',x->>'source_row_id')) FROM jsonb_array_elements(p_sources) x)
  OR jsonb_array_length(p_sources)<>(SELECT count(DISTINCT x->>'event_id') FROM jsonb_array_elements(p_sources) x) THEN
  RAISE EXCEPTION 'memory_source_use_invalid' USING ERRCODE='22023';
 END IF;
 governance:=public.sophia_memory_ensure_governance(p_user_id);
 -- The active action is still strictly current-epoch, exact and independently
 -- recorded. Old actions/retries cannot turn this read into renewed consent.
 PERFORM public.sophia_memory_assert_recorded_model_sources(p_user_id,jsonb_build_array(p_current_source),
  governance.memory_clear_epoch,p_current_source->>'thread_id',false);
 FOR witness IN SELECT value FROM jsonb_array_elements(p_sources)
  ORDER BY value->>'session_id',value->>'source_row_id'
 LOOP
  SELECT source_intake_receipt INTO original FROM public.sophia_memory_governance_events
   WHERE user_id=p_user_id AND source_intake_receipt->>'command_key'=witness->>'command_key';
  IF original IS NULL THEN RAISE EXCEPTION 'memory_model_source_unavailable' USING ERRCODE='40001'; END IF;
  SELECT jsonb_object_agg(key,value) INTO expected_witness FROM jsonb_each(original) WHERE key=ANY(ARRAY[
   'owner_id','session_id','thread_id','command_key','event_id','message_id','source_row_id','source_version','sequence','memory_clear_epoch','content_ref']);
  expected_witness:=expected_witness||jsonb_build_object('schema','mem00.recorded-input-source.v1');
  IF witness IS DISTINCT FROM expected_witness OR witness->>'owner_id' IS DISTINCT FROM p_user_id
   OR witness->>'thread_id' IS DISTINCT FROM p_current_source->>'thread_id' THEN
   RAISE EXCEPTION 'memory_model_source_changed' USING ERRCODE='40001';
  END IF;
  source_epoch:=(witness->>'memory_clear_epoch')::bigint;
  IF source_epoch>governance.memory_clear_epoch OR source_epoch<0
   OR (source_epoch<governance.memory_clear_epoch AND
    (witness->>'session_id' IS DISTINCT FROM p_current_source->>'session_id'
     OR (witness->>'sequence')::bigint >= (p_current_source->>'sequence')::bigint)) THEN
   RAISE EXCEPTION 'memory_source_use_scope_changed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=witness->>'session_id' FOR SHARE;
  IF NOT FOUND OR parent.thread_id IS DISTINCT FROM witness->>'thread_id' OR parent.status IS NULL
   OR parent.status NOT IN ('active','resumable') OR coalesce(parent.metadata,'{}')?'synthetic_voice_lab'
   OR public.sophia_memory_source_fenced(p_user_id,parent.id) IS DISTINCT FROM false THEN
   RAISE EXCEPTION 'memory_model_source_unavailable' USING ERRCODE='40001';
  END IF;
  SELECT * INTO source_row FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=parent.id
   AND id=witness->>'source_row_id' AND message_id=witness->>'message_id' FOR SHARE;
  IF NOT FOUND OR source_row.thread_id IS DISTINCT FROM parent.thread_id OR source_row.role IS DISTINCT FROM 'user'
   OR source_row.final IS DISTINCT FROM true OR nullif(btrim(source_row.content),'') IS NULL
   OR source_row.sequence IS DISTINCT FROM (witness->>'sequence')::bigint
   OR source_row.memory_source_version::text IS DISTINCT FROM witness->>'source_version'
   OR source_row.memory_source_acceptance_epoch IS DISTINCT FROM source_epoch
   OR (source_row.memory_source_accepted_version IS DISTINCT FROM source_row.memory_source_version
    AND NOT(source_epoch=0 AND source_row.memory_source_accepted_version IS NULL)) THEN
   RAISE EXCEPTION 'memory_model_source_changed' USING ERRCODE='40001';
  END IF;
 END LOOP;
 RETURN jsonb_build_object('schema','mem00.source-use-check.v1','owner_id',p_user_id,
  'thread_id',p_current_source->>'thread_id','current_source_event_id',p_current_source->>'event_id',
  'memory_clear_epoch',governance.memory_clear_epoch,'source_dependencies',p_sources,'source_use_status','current',
  'memory_approval','not_granted','extraction_eligibility','unchanged','final_dispatch_permission',false);
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_check_source_use(text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.sophia_memory_authorize_model_dispatch(p_user_id text,p_attempt jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; witness jsonb; binding jsonb; handoff jsonb; completion jsonb;
  prior public.sophia_memory_prompt_admissions; attempt_id uuid; run_id uuid; prior_id uuid;
  admission_id uuid; event_id uuid:=gen_random_uuid(); accepted timestamptz; receipt jsonb; keys text[];
BEGIN
  IF p_attempt IS NULL OR jsonb_typeof(p_attempt)<>'object' OR octet_length(p_attempt::text)>262144 THEN
    RAISE EXCEPTION 'memory_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(p_attempt) key;
  IF keys IS DISTINCT FROM ARRAY['attempt_id','authorized_manifest','builder_binding','catalog_generation','completion_binding','contract_epoch','endpoint_ref','environment',
    'model_ref','payload_ref','prior_admission_id','provider','provider_namespace','provider_project','revocation_epoch',
    'run_id','schema','scope','source_dependencies','source_witness','thread_id']::text[] THEN
    RAISE EXCEPTION 'memory_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  IF p_attempt->>'schema' IS DISTINCT FROM 'mem00.model-attempt.v4' OR p_attempt->>'provider' IS DISTINCT FROM 'mem0'
    OR p_attempt->>'payload_ref' IS NULL OR p_attempt->>'payload_ref' !~ '^hmac-sha256:model-payload:[a-f0-9]{64}$'
    OR p_attempt->>'endpoint_ref' IS NULL OR p_attempt->>'endpoint_ref' !~ '^hmac-sha256:model-endpoint:[a-f0-9]{64}$'
    OR p_attempt->>'model_ref' IS NULL OR p_attempt->>'model_ref' !~ '^hmac-sha256:model-route:[a-f0-9]{64}$'
    OR jsonb_typeof(p_attempt->'authorized_manifest') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_attempt->'authorized_manifest')>100
    OR p_attempt->>'catalog_generation' IS NULL OR p_attempt->>'catalog_generation' !~ '^[0-9]+$'
    OR jsonb_typeof(p_attempt->'catalog_generation') IS DISTINCT FROM 'number'
    OR p_attempt->>'revocation_epoch' IS NULL OR p_attempt->>'revocation_epoch' !~ '^[0-9]+$'
    OR jsonb_typeof(p_attempt->'revocation_epoch') IS DISTINCT FROM 'number'
    OR p_attempt->'contract_epoch' IS DISTINCT FROM '1'::jsonb THEN
    RAISE EXCEPTION 'memory_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(ARRAY['thread_id','scope','environment','provider_project','provider_namespace','attempt_id','run_id','prior_admission_id']) key
    WHERE jsonb_typeof(p_attempt->key) IS DISTINCT FROM 'string' OR nullif(p_attempt->>key,'') IS NULL OR length(p_attempt->>key)>512) THEN
    RAISE EXCEPTION 'memory_model_attempt_invalid' USING ERRCODE='22023';
  END IF;
  attempt_id:=(p_attempt->>'attempt_id')::uuid;run_id:=(p_attempt->>'run_id')::uuid;prior_id:=(p_attempt->>'prior_admission_id')::uuid;
  IF jsonb_array_length(p_attempt->'authorized_manifest')<>(SELECT count(DISTINCT x->>'memory_id') FROM jsonb_array_elements(p_attempt->'authorized_manifest') x)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_attempt->'authorized_manifest') x WHERE jsonb_typeof(x)<>'object'
      OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(x) k) IS DISTINCT FROM ARRAY['content_revision','memory_governance_revision','memory_id']
      OR jsonb_typeof(x->'memory_id') IS DISTINCT FROM 'string' OR x->>'memory_id' !~ '^[a-fA-F0-9-]{36}$'
      OR jsonb_typeof(x->'content_revision') IS DISTINCT FROM 'number' OR x->>'content_revision' !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(x->'memory_governance_revision') IS DISTINCT FROM 'number' OR x->>'memory_governance_revision' !~ '^[1-9][0-9]*$') THEN
    RAISE EXCEPTION 'memory_model_manifest_invalid' USING ERRCODE='22023';
  END IF;

  -- Same owner lock as edit/forget/tombstone/clear. Never hold it across HTTP.
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND mode='enforced' AND schema_version='mem00.v1'
    AND contract_epoch=1 AND contract_epoch=governance.authority_epoch FOR SHARE;
  IF NOT FOUND OR governance.authority_state IS DISTINCT FROM 'governed'
    OR governance.provider_subject IS DISTINCT FROM p_attempt->>'provider_namespace'
    OR governance.user_catalog_generation IS DISTINCT FROM (p_attempt->>'catalog_generation')::bigint
    OR governance.user_revocation_epoch IS DISTINCT FROM (p_attempt->>'revocation_epoch')::bigint THEN
    RAISE EXCEPTION 'memory_model_governance_changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sophia_memory_governance_events e WHERE e.model_dispatch_receipt->>'attempt_id'=attempt_id::text) THEN
    RAISE EXCEPTION 'memory_model_attempt_consumed' USING ERRCODE='40001';
  END IF;
  -- Earlier read admission supplies bounded provider-availability evidence only;
  -- it is not the final permit. Revalidate all canonical inclusions below.
  SELECT * INTO prior FROM public.sophia_memory_prompt_admissions WHERE user_id=p_user_id AND prompt_admission_id=prior_id;
  IF NOT FOUND OR prior.provider_status IS DISTINCT FROM 'ok' OR prior.scope IS DISTINCT FROM p_attempt->>'scope'
    OR prior.availability_context IS DISTINCT FROM jsonb_build_object('provider',p_attempt->>'provider','environment',p_attempt->>'environment',
      'provider_project',p_attempt->>'provider_project','provider_namespace',p_attempt->>'provider_namespace')
    OR prior.authorized_manifest IS DISTINCT FROM p_attempt->'authorized_manifest'
    OR prior.catalog_generation_checked IS DISTINCT FROM governance.user_catalog_generation
    OR prior.revocation_epoch_checked IS DISTINCT FROM governance.user_revocation_epoch
    OR prior.created_at>clock_timestamp() OR prior.created_at<clock_timestamp()-interval '5 seconds'
    OR prior.outcome NOT IN ('authorized','zero_memory') THEN
    RAISE EXCEPTION 'memory_model_availability_unproven' USING ERRCODE='40001';
  END IF;
  IF p_attempt->'completion_binding' IS DISTINCT FROM 'null'::jsonb
    OR (jsonb_typeof(p_attempt->'builder_binding')='object' AND
      (p_attempt->'authorized_manifest' IS DISTINCT FROM '[]'::jsonb
       OR p_attempt->'builder_binding'->'initial_memory_manifest' IS DISTINCT FROM '[]'::jsonb)) THEN
    RAISE EXCEPTION 'memory_c2_consumer_disabled' USING ERRCODE='40001';
  END IF;
  -- Exactly one explicit source authority. Missing fields and old binaries deny.
  IF (CASE WHEN jsonb_typeof(p_attempt->'source_witness')='object' THEN 1 ELSE 0 END
    +CASE WHEN jsonb_typeof(p_attempt->'builder_binding')='object' THEN 1 ELSE 0 END
    +CASE WHEN jsonb_typeof(p_attempt->'completion_binding')='object' THEN 1 ELSE 0 END)<>1
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['source_witness','builder_binding','completion_binding']) key
      WHERE jsonb_typeof(p_attempt->key) NOT IN ('object','null')) THEN
    RAISE EXCEPTION 'memory_model_source_authority_ambiguous' USING ERRCODE='22023';
  END IF;
  -- Ordinary, child and completion authority are mutually exclusive. A historical Builder
  -- receipt binds the original payload to the actual child run; it is not a
  -- reusable model permit, and cannot replace current source/canonical checks.
  IF jsonb_typeof(p_attempt->'source_witness')='object' THEN
    witness:=p_attempt->'source_witness';
    IF witness->>'thread_id' IS DISTINCT FROM p_attempt->>'thread_id' THEN
      RAISE EXCEPTION 'memory_model_source_thread_changed' USING ERRCODE='40001';
    END IF;
    IF jsonb_typeof(witness) IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_attempt->'source_dependencies') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'memory_model_sources_unproven' USING ERRCODE='22023';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_attempt->'source_dependencies') x WHERE x=witness) THEN
      RAISE EXCEPTION 'memory_model_sources_unproven' USING ERRCODE='22023';
    END IF;
    PERFORM public.sophia_memory_check_source_use(p_user_id,witness,p_attempt->'source_dependencies');
  ELSIF jsonb_typeof(p_attempt->'builder_binding')='object' THEN
    IF p_attempt->'source_witness' IS DISTINCT FROM 'null'::jsonb
      OR jsonb_typeof(p_attempt->'builder_binding') IS DISTINCT FROM 'object'
      OR p_attempt->>'scope' IS DISTINCT FROM 'builder' THEN
      RAISE EXCEPTION 'memory_model_builder_binding_unproven' USING ERRCODE='22023';
    END IF;
    SELECT e.builder_source_receipt INTO binding FROM public.sophia_memory_governance_events e
      WHERE e.user_id=p_user_id AND e.event_id=(p_attempt->'builder_binding'->>'binding_event_id')::uuid
      AND e.builder_source_receipt->>'schema'='mem00.builder-source-run.v1';
    IF binding IS NULL OR binding IS DISTINCT FROM p_attempt->'builder_binding'
      OR binding->>'owner_id' IS DISTINCT FROM p_user_id
      OR binding->>'child_thread_id' IS DISTINCT FROM p_attempt->>'thread_id'
      OR binding->>'child_run_id' IS DISTINCT FROM run_id::text
      OR binding->'source_dependencies' IS DISTINCT FROM p_attempt->'source_dependencies'
      OR (binding->>'memory_clear_epoch')::bigint IS DISTINCT FROM governance.memory_clear_epoch THEN
      RAISE EXCEPTION 'memory_model_builder_binding_changed' USING ERRCODE='40001';
    END IF;
    SELECT e.builder_source_receipt INTO handoff FROM public.sophia_memory_governance_events e
      WHERE e.user_id=p_user_id AND e.event_id=(binding->>'handoff_event_id')::uuid
      AND e.builder_source_receipt->>'schema'='mem00.builder-source-handoff-receipt.v1';
    IF handoff IS NULL OR handoff->>'child_thread_id' IS DISTINCT FROM binding->>'child_thread_id'
      OR handoff->'request'->>'payload_ref' IS DISTINCT FROM binding->>'payload_ref'
      OR handoff->'request'->>'parent_run_id' IS DISTINCT FROM binding->>'parent_run_id'
      OR handoff->'request'->>'parent_thread_id' IS DISTINCT FROM binding->>'parent_thread_id'
      OR handoff->'request'->'source_dependencies' IS DISTINCT FROM binding->'source_dependencies'
      OR handoff->'initial_memory_manifest' IS DISTINCT FROM binding->'initial_memory_manifest'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(binding->'initial_memory_manifest') initial
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_attempt->'authorized_manifest') current WHERE current=initial)) THEN
      RAISE EXCEPTION 'memory_model_builder_manifest_unproven' USING ERRCODE='40001';
    END IF;
    -- Ending the original conversation does not erase an authorized task.
    -- Source edits/deletion/clear still invalidate every later physical attempt.
    PERFORM public.sophia_memory_assert_recorded_model_sources(p_user_id,p_attempt->'source_dependencies',
      governance.memory_clear_epoch,binding->>'parent_thread_id',true);
    witness:=p_attempt->'source_dependencies'->0;
  ELSE
    RAISE EXCEPTION 'memory_c2_completion_disabled' USING ERRCODE='40001';
  END IF;
  admission_id:=public.sophia_memory_record_prompt_admission(attempt_id,p_user_id,'final_model_dispatch',p_attempt->>'scope',
    p_attempt->>'payload_ref',p_attempt->>'provider',p_attempt->>'environment',p_attempt->>'provider_project',p_attempt->>'provider_namespace',
    'ok',0,governance.user_catalog_generation,governance.user_revocation_epoch,p_attempt->'authorized_manifest','{}',
    CASE WHEN jsonb_array_length(p_attempt->'authorized_manifest')=0 THEN 'zero_memory' ELSE 'authorized' END,NULL,'{}');
  accepted:=clock_timestamp();
  receipt:=jsonb_build_object('schema','mem00.model-dispatch.v4','owner_id',p_user_id,'attempt_id',attempt_id,'run_id',run_id,
    'thread_id',p_attempt->>'thread_id','event_id',event_id,'prompt_admission_id',admission_id,'prior_admission_id',prior_id,
    'payload_ref',p_attempt->>'payload_ref','endpoint_ref',p_attempt->>'endpoint_ref','model_ref',p_attempt->>'model_ref',
    'catalog_generation',governance.user_catalog_generation,'revocation_epoch',governance.user_revocation_epoch,
    'memory_clear_epoch',governance.memory_clear_epoch,'authorized_manifest',p_attempt->'authorized_manifest',
    'source_event_id',CASE WHEN binding IS NULL THEN witness->>'event_id' ELSE NULL END,
    'builder_binding_id',CASE WHEN completion IS NULL THEN binding->>'binding_event_id' ELSE NULL END,
    'completion_binding_id',completion->>'binding_event_id','source_dependencies',p_attempt->'source_dependencies','accepted_at',accepted,'expires_at',accepted+interval '5 seconds',
    'single_use',true,'dispatch_observed',false);
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,
    safe_reason_code,user_catalog_generation,user_revocation_epoch,source_session_id,model_dispatch_receipt)
  VALUES(event_id,attempt_id::text,'model-dispatch:'||attempt_id::text,p_attempt->>'payload_ref',p_user_id,'model_dispatch_authorized','system',
    'exact_final_model_admitted',governance.user_catalog_generation,governance.user_revocation_epoch,witness->>'session_id',receipt);
  RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_model_dispatch_immutable(),public.sophia_memory_authorize_model_dispatch(text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_model_result_attempt
 ON public.sophia_memory_governance_events(user_id,(builder_source_receipt->'request'->>'attempt_id'))
 WHERE builder_source_receipt->>'schema'='mem00.model-result.v1';

CREATE OR REPLACE FUNCTION public.sophia_memory_get_model_result(p_user_id text,p_attempt_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
 SELECT builder_source_receipt FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND builder_source_receipt->>'schema'='mem00.model-result.v1'
  AND builder_source_receipt->'request'->>'attempt_id'=p_attempt_id::text
$fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_record_model_result(p_user_id text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; original jsonb; admission jsonb; receipt jsonb;
 event uuid:=gen_random_uuid(); keys text[]; call jsonb;
BEGIN
 IF p_request IS NULL OR jsonb_typeof(p_request)<>'object' OR octet_length(p_request::text)>65536 THEN
  RAISE EXCEPTION 'memory_model_result_request_invalid' USING ERRCODE='22023';
 END IF;
 SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(p_request) key;
 IF keys IS DISTINCT FROM ARRAY['attempt_id','model_admission_event_id','payload_ref','result_ref','run_id','schema','thread_id','tool_calls']::text[]
  OR p_request->>'schema' IS DISTINCT FROM 'mem00.model-result-request.v1'
  OR jsonb_typeof(p_request->'tool_calls') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'memory_model_result_request_invalid' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_request->'tool_calls')>128 THEN
  RAISE EXCEPTION 'memory_model_result_tool_budget' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['attempt_id','model_admission_event_id','run_id','thread_id']) key
  WHERE jsonb_typeof(p_request->key) IS DISTINCT FROM 'string'
   OR p_request->>key !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') THEN
  RAISE EXCEPTION 'memory_model_result_identity_invalid' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM (VALUES('payload_ref','model-payload'),('result_ref','model-result')) refs(key,domain)
  WHERE jsonb_typeof(p_request->key) IS DISTINCT FROM 'string'
   OR p_request->>key !~ ('^hmac-sha256:'||domain||':[a-f0-9]{64}$')) THEN
  RAISE EXCEPTION 'memory_model_result_reference_invalid' USING ERRCODE='22023';
 END IF;
 FOR call IN SELECT value FROM jsonb_array_elements(p_request->'tool_calls') LOOP
  IF jsonb_typeof(call)<>'object' THEN RAISE EXCEPTION 'memory_model_result_tool_invalid' USING ERRCODE='22023'; END IF;
  SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(call) key;
  IF keys IS DISTINCT FROM ARRAY['arguments_ref','tool_call_ref','tool_name']::text[]
   OR jsonb_typeof(call->'tool_name') IS DISTINCT FROM 'string' OR call->>'tool_name' !~ '^[A-Za-z0-9_-]{1,128}$'
   OR jsonb_typeof(call->'tool_call_ref') IS DISTINCT FROM 'string' OR call->>'tool_call_ref' !~ '^hmac-sha256:model-tool-call:[a-f0-9]{64}$'
   OR jsonb_typeof(call->'arguments_ref') IS DISTINCT FROM 'string' OR call->>'arguments_ref' !~ '^hmac-sha256:model-tool-arguments:[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'memory_model_result_tool_invalid' USING ERRCODE='22023';
  END IF;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'tool_call_ref') FROM jsonb_array_elements(p_request->'tool_calls'))<>jsonb_array_length(p_request->'tool_calls') THEN
  RAISE EXCEPTION 'memory_model_result_duplicate_tool' USING ERRCODE='22023';
 END IF;
 governance:=public.sophia_memory_ensure_governance(p_user_id);
 original:=public.sophia_memory_get_model_result(p_user_id,(p_request->>'attempt_id')::uuid);
 IF original IS NOT NULL THEN
  IF original->'request' IS DISTINCT FROM p_request THEN
   RAISE EXCEPTION 'memory_model_result_conflict' USING ERRCODE='23505';
  END IF;
  RETURN original;
 END IF;
 SELECT model_dispatch_receipt INTO admission FROM public.sophia_memory_governance_events
  WHERE user_id=p_user_id AND event_id=(p_request->>'model_admission_event_id')::uuid
   AND model_dispatch_receipt->>'attempt_id'=p_request->>'attempt_id';
 IF admission IS NULL OR admission->>'schema' IS DISTINCT FROM 'mem00.model-dispatch.v4'
  OR admission->>'owner_id' IS DISTINCT FROM p_user_id OR admission->>'event_id' IS DISTINCT FROM p_request->>'model_admission_event_id'
  OR admission->>'run_id' IS DISTINCT FROM p_request->>'run_id' OR admission->>'thread_id' IS DISTINCT FROM p_request->>'thread_id'
  OR admission->>'payload_ref' IS DISTINCT FROM p_request->>'payload_ref' THEN
  RAISE EXCEPTION 'memory_model_result_origin_unproven' USING ERRCODE='40001';
 END IF;
 -- Preserve the full original source/memory union from canonical admission.
 -- Never replace it with caller assertions or stamp current clocks onto it.
 receipt:=jsonb_build_object('schema','mem00.model-result.v1','owner_id',p_user_id,'event_id',event,
  'request',p_request,'admission',admission,'historical_result_only',true,'model_reuse_permission',false);
 INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,
  safe_reason_code,user_catalog_generation,user_revocation_epoch,builder_source_receipt)
 VALUES(event,p_request->>'attempt_id','model-result:'||(p_request->>'attempt_id'),p_request->>'result_ref',p_user_id,
  'model_result_observed','system','historical_model_result_not_reuse',governance.user_catalog_generation,governance.user_revocation_epoch,receipt);
 RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_get_model_result(text,uuid),public.sophia_memory_record_model_result(text,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
