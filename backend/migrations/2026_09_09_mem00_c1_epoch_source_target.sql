-- Eleventh private C1 stage. Exact partition and epoch-aware aligner; ordinary
-- producer/review integration is still required. No application grants/deploy.
BEGIN;
CREATE OR REPLACE FUNCTION public.sophia_memory_source_snapshot(p_user_id text,p_session_id text,p_thread_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; parent public.sophia_sessions;
  sources jsonb; result jsonb;
BEGIN
  -- STABLE: owner, parent and complete partition share the caller's MVCC view.
  -- This is read evidence, not permission for a later effect or SDK dispatch.
  SELECT g.* INTO governance FROM public.sophia_memory_user_governance g
    JOIN public.sophia_memory_contract c ON c.singleton AND c.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed' AND c.contract_epoch=1
      AND c.schema_version='mem00.v1' AND c.mode IN ('shadow','enforced');
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_source_authority_unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id;
  IF NOT FOUND OR p_thread_id IS NULL OR parent.thread_id IS DISTINCT FROM p_thread_id
    OR parent.message_revision IS NULL OR parent.message_revision<0 OR parent.status IS NULL
    OR parent.status NOT IN ('active','resumable','ended')
    OR coalesce(parent.metadata,'{}') ? 'synthetic_voice_lab'
    OR public.sophia_memory_source_fenced(p_user_id,p_session_id) IS NOT FALSE THEN
    RAISE EXCEPTION 'memory_source_session_unavailable' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('message_id',message_id,'sequence',sequence,'source_version',memory_source_version,
    'acceptance_epoch',memory_source_acceptance_epoch,'accepted_version',memory_source_accepted_version,
    'eligibility',CASE WHEN memory_source_acceptance_epoch<governance.memory_clear_epoch THEN 'before_clear'
      WHEN memory_source_acceptance_epoch=governance.memory_clear_epoch AND (governance.memory_clear_epoch=0 OR memory_source_accepted_version=memory_source_version) THEN 'eligible'
      WHEN memory_source_accepted_version IS NULL THEN 'acceptance_unproven' ELSE 'accepted_version_changed' END)
    ORDER BY sequence,message_id),'[]'::jsonb) INTO sources
    FROM (SELECT * FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id
      AND final AND role IN ('user','assistant') AND btrim(content)<>'' ORDER BY sequence,message_id LIMIT 10001) m;
  IF jsonb_array_length(sources)>10000 OR octet_length(sources::text)>8388608
    OR jsonb_array_length(sources)<>(SELECT count(DISTINCT x->>'message_id') FROM jsonb_array_elements(sources) x)
    OR jsonb_array_length(sources)<>(SELECT count(DISTINCT x->>'sequence') FROM jsonb_array_elements(sources) x)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(sources) x WHERE x->>'message_id' IS NULL OR x->>'message_id'=''
      OR x->>'source_version' IS NULL OR x->>'sequence' IS NULL OR (x->>'sequence')::bigint<=0
      OR x->>'acceptance_epoch' IS NULL OR (x->>'acceptance_epoch')::bigint>governance.memory_clear_epoch)
    OR EXISTS(SELECT 1 FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id
      AND final AND role IN ('user','assistant') AND btrim(content)<>'' AND thread_id IS DISTINCT FROM p_thread_id) THEN
    RAISE EXCEPTION 'memory_source_partition_unavailable' USING ERRCODE='42501';
  END IF;
  result:=jsonb_build_object('schema','mem00.source-snapshot.v1','owner_id',p_user_id,'session_id',p_session_id,
    'thread_id',p_thread_id,'transcript_revision',parent.message_revision,'memory_clear_epoch',governance.memory_clear_epoch,
    'context_mode',coalesce(nullif(parent.metadata->>'context_mode',''),'life'),'status',parent.status,
    'ended_at',parent.ended_at,'sources',sources);
  RETURN result||jsonb_build_object('snapshot_id','mem00-source-snapshot-'||md5(result::text));
END $fn$;
CREATE OR REPLACE FUNCTION public.sophia_memory_apply_source_target_at_epoch(
  p_user_id text,p_session_id text,p_thread_id text,p_transcript_revision bigint,
  p_target_manifest_ref text,p_observed_runs jsonb,p_reused_runs jsonb,p_next_range jsonb,
  p_extractor_contract_version text,p_extractor_model text,p_extractor_prompt_version text,
  p_modality text,p_ended_at timestamptz,p_idempotency_key text,p_request_digest text,
  p_expected_clear_epoch bigint,p_source_snapshot jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; parent public.sophia_sessions;
  previous public.sophia_memory_governance_events; run public.sophia_memory_extraction_runs;
  snapshot jsonb; actual jsonb; witness jsonb; dependencies jsonb; result_run jsonb:=NULL; receipt jsonb;
  invalidated uuid[]:=ARRAY[]::uuid[]; candidate_ids uuid[]:=ARRAY[]::uuid[];
  first_sequence bigint; last_sequence bigint; target_event_id uuid:=gen_random_uuid();
BEGIN
  IF p_expected_clear_epoch IS NULL OR p_expected_clear_epoch<0 OR p_request_digest IS NULL
    OR p_request_digest !~ '^hmac-sha256:request:[a-f0-9]{64}$' OR p_idempotency_key IS NULL
    OR p_idempotency_key !~ '^hmac-sha256:source-target-at-epoch-v1:[a-f0-9]{64}$'
    OR p_target_manifest_ref IS NULL OR p_target_manifest_ref !~ '^hmac-sha256:transcript-manifest:[a-f0-9]{64}$'
    OR p_extractor_contract_version IS DISTINCT FROM 'mem00.extract.v1'
    OR p_extractor_prompt_version IS DISTINCT FROM 'mem0_extraction.md:v1' OR nullif(p_extractor_model,'') IS NULL THEN
    RAISE EXCEPTION 'memory_source_target_invalid' USING ERRCODE='22023';
  END IF;
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO previous FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF previous.event_type IS DISTINCT FROM 'source_target_at_epoch_aligned'
      OR previous.request_digest IS DISTINCT FROM p_request_digest OR previous.source_target_receipt IS NULL
      OR previous.source_target_receipt->'source_snapshot' IS DISTINCT FROM p_source_snapshot
      OR previous.source_target_receipt->>'source_manifest_ref' IS DISTINCT FROM p_target_manifest_ref
      OR (previous.source_target_receipt->>'memory_clear_epoch')::bigint IS DISTINCT FROM p_expected_clear_epoch THEN
      RAISE EXCEPTION 'memory_idempotency_digest_conflict' USING ERRCODE='23505';
    END IF;
    RETURN previous.source_target_receipt||jsonb_build_object('idempotent_replay',true);
  END IF;
  PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1'
    AND contract_epoch=1 AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_source_authority_unavailable' USING ERRCODE='42501'; END IF;
  IF governance.memory_clear_epoch IS DISTINCT FROM p_expected_clear_epoch THEN
    RAISE EXCEPTION 'memory_clear_epoch_stale' USING ERRCODE='40001';
  END IF;
  SELECT * INTO STRICT parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id FOR UPDATE;
  snapshot:=public.sophia_memory_source_snapshot(p_user_id,p_session_id,p_thread_id);
  IF snapshot IS DISTINCT FROM p_source_snapshot OR parent.message_revision IS DISTINCT FROM p_transcript_revision THEN
    RAISE EXCEPTION 'memory_source_snapshot_changed' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('extraction_run_id',extraction_run_id,'state',state,
    'input_manifest_ref',input_manifest_ref) ORDER BY extraction_run_id),'[]'::jsonb) INTO actual
    FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND session_id=p_session_id AND state<>'superseded';
  IF actual IS DISTINCT FROM p_observed_runs THEN RAISE EXCEPTION 'memory_source_runs_changed' USING ERRCODE='40001'; END IF;
  IF jsonb_typeof(p_reused_runs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_reused_runs)>10000
    OR jsonb_array_length(p_reused_runs)<>(SELECT count(DISTINCT x->>'extraction_run_id') FROM jsonb_array_elements(p_reused_runs) x) THEN
    RAISE EXCEPTION 'memory_source_witness_invalid' USING ERRCODE='22023';
  END IF;
  FOR witness IN SELECT value FROM jsonb_array_elements(p_reused_runs) LOOP
    SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND session_id=p_session_id
      AND extraction_run_id=(witness->>'extraction_run_id')::uuid FOR UPDATE;
    IF run.state='superseded' OR run.memory_clear_epoch IS DISTINCT FROM p_expected_clear_epoch
      OR run.thread_id IS DISTINCT FROM p_thread_id OR run.input_manifest_ref IS DISTINCT FROM witness->>'input_manifest_ref'
      OR run.extractor_contract_version IS DISTINCT FROM p_extractor_contract_version
      OR run.extractor_model IS DISTINCT FROM p_extractor_model OR run.extractor_prompt_version IS DISTINCT FROM p_extractor_prompt_version
      OR public.sophia_memory_run_source_valid(p_user_id,p_session_id,run.sequence_start,run.sequence_end,witness->'dependencies') IS NOT TRUE
      OR run.source_dependencies IS DISTINCT FROM witness->'dependencies'
      OR run.extractor_input_ref IS DISTINCT FROM witness->>'extractor_input_ref'
      OR run.extractor_input_context IS DISTINCT FROM witness->'extractor_input_context'
      OR public.sophia_memory_run_input_valid(p_user_id,p_session_id,run.extractor_input_context,run.extractor_input_ref) IS NOT TRUE THEN
      RAISE EXCEPTION 'memory_source_witness_invalid' USING ERRCODE='40001';
    END IF;
    UPDATE public.sophia_memory_extraction_runs SET validated_transcript_revision=p_transcript_revision,updated_at=now()
      WHERE extraction_run_id=run.extraction_run_id;
  END LOOP;
  SELECT coalesce(array_agg(extraction_run_id),ARRAY[]::uuid[]) INTO invalidated FROM public.sophia_memory_extraction_runs r
    WHERE user_id=p_user_id AND session_id=p_session_id AND state<>'superseded' AND memory_clear_epoch=p_expected_clear_epoch
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_reused_runs) w WHERE (w->>'extraction_run_id')::uuid=r.extraction_run_id);
  SELECT coalesce(array_agg(candidate_id),ARRAY[]::uuid[]) INTO candidate_ids FROM public.sophia_memory_candidates
    WHERE user_id=p_user_id AND extraction_run_id=ANY(invalidated) AND review_state='pending_review';
  UPDATE public.sophia_memory_candidates SET review_state='expired',expired_at=now(),scrubbed_at=now() WHERE candidate_id=ANY(candidate_ids);
  UPDATE public.sophia_memory_candidate_versions SET proposed_content=NULL,content_ref=NULL,scrubbed_at=now()
    WHERE user_id=p_user_id AND candidate_id=ANY(candidate_ids) AND scrubbed_at IS NULL;
  UPDATE public.sophia_memory_candidate_sources SET invalidated_at=coalesce(invalidated_at,now()),detached_at=coalesce(detached_at,now())
    WHERE user_id=p_user_id AND candidate_id IN (SELECT candidate_id FROM public.sophia_memory_candidates WHERE extraction_run_id=ANY(invalidated));
  UPDATE public.sophia_memory_versions v SET source_link_manifest=coalesce((SELECT jsonb_agg(x)
    FROM jsonb_array_elements(v.source_link_manifest) x WHERE x->>'session_id'<>p_session_id),'[]'::jsonb)
    WHERE v.user_id=p_user_id AND v.memory_id IN (SELECT m.memory_id FROM public.sophia_memories m
      JOIN public.sophia_memory_candidates c ON c.candidate_id=m.origin_candidate_id AND c.user_id=m.user_id WHERE c.extraction_run_id=ANY(invalidated));
  UPDATE public.sophia_memory_extraction_runs SET state='superseded',validated_transcript_revision=p_transcript_revision,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,terminal_at=coalesce(terminal_at,now()),updated_at=now(),safe_terminal_reason='source_dependency_changed'
    WHERE extraction_run_id=ANY(invalidated);
  -- An excluded visible occurrence is a real interval barrier. Do not filter it
  -- out before computing endpoints: the extraction reader loads whole ranges.
  WITH target AS (SELECT (x->>'sequence')::bigint sequence,x->>'eligibility'='eligible' eligible,
    EXISTS(SELECT 1 FROM public.sophia_memory_extraction_runs r WHERE r.user_id=p_user_id AND r.session_id=p_session_id
      AND r.state<>'superseded' AND r.memory_clear_epoch=p_expected_clear_epoch AND r.validated_transcript_revision=p_transcript_revision
      AND (x->>'sequence')::bigint BETWEEN r.sequence_start AND r.sequence_end) reserved
    FROM jsonb_array_elements(snapshot->'sources') x)
  SELECT min(sequence) FILTER(WHERE eligible AND NOT reserved) INTO first_sequence FROM target;
  IF first_sequence IS NOT NULL THEN
    WITH target AS (SELECT (x->>'sequence')::bigint sequence,x->>'eligibility'='eligible' eligible,
      EXISTS(SELECT 1 FROM public.sophia_memory_extraction_runs r WHERE r.user_id=p_user_id AND r.session_id=p_session_id
        AND r.state<>'superseded' AND r.memory_clear_epoch=p_expected_clear_epoch AND r.validated_transcript_revision=p_transcript_revision
        AND (x->>'sequence')::bigint BETWEEN r.sequence_start AND r.sequence_end) reserved
      FROM jsonb_array_elements(snapshot->'sources') x)
    SELECT max(sequence) INTO last_sequence FROM target WHERE sequence>=first_sequence
      AND sequence<coalesce((SELECT min(sequence) FROM target WHERE sequence>first_sequence AND (NOT eligible OR reserved)),9223372036854775807);
    IF p_next_range IS NULL OR (p_next_range->>'sequence_start')::bigint IS DISTINCT FROM first_sequence
      OR (p_next_range->>'sequence_end')::bigint IS DISTINCT FROM last_sequence THEN
      RAISE EXCEPTION 'memory_source_range_conflict' USING ERRCODE='40001';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('message_id',x->>'message_id','sequence',(x->>'sequence')::bigint,'source_version',x->>'source_version')
      ORDER BY (x->>'sequence')::bigint,x->>'message_id') INTO dependencies FROM jsonb_array_elements(snapshot->'sources') x
      WHERE (x->>'sequence')::bigint BETWEEN first_sequence AND last_sequence;
    IF public.sophia_memory_run_source_valid(p_user_id,p_session_id,first_sequence,last_sequence,dependencies) IS NOT TRUE
      OR public.sophia_memory_run_input_valid(p_user_id,p_session_id,p_next_range->'extractor_input_context',p_next_range->>'extractor_input_ref') IS NOT TRUE THEN
      RAISE EXCEPTION 'memory_extractor_input_invalid' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.sophia_memory_extraction_runs(user_id,idempotency_key,request_digest,session_id,thread_id,modality,
      transcript_revision,sequence_start,sequence_end,input_manifest_ref,extractor_contract_version,extractor_model,extractor_prompt_version,
      source_dependencies,validated_transcript_revision,extractor_input_context,extractor_input_ref,memory_clear_epoch)
    VALUES(p_user_id,p_idempotency_key||':range',p_request_digest,p_session_id,p_thread_id,p_modality,p_transcript_revision,
      first_sequence,last_sequence,p_next_range->>'input_manifest_ref',p_extractor_contract_version,p_extractor_model,p_extractor_prompt_version,
      dependencies,p_transcript_revision,p_next_range->'extractor_input_context',p_next_range->>'extractor_input_ref',p_expected_clear_epoch) RETURNING * INTO run;
    result_run:=to_jsonb(run);
  ELSIF p_next_range IS NOT NULL THEN RAISE EXCEPTION 'memory_source_range_conflict' USING ERRCODE='40001'; END IF;
  IF p_ended_at IS NOT NULL THEN UPDATE public.sophia_sessions SET status='ended',ended_at=coalesce(ended_at,p_ended_at),updated_at=now()
    WHERE user_id=p_user_id AND id=p_session_id; END IF;
  IF result_run IS NULL THEN SELECT to_jsonb(r) INTO result_run FROM public.sophia_memory_extraction_runs r
    WHERE r.user_id=p_user_id AND r.session_id=p_session_id AND r.memory_clear_epoch=p_expected_clear_epoch
      AND r.validated_transcript_revision=p_transcript_revision AND r.state IN ('queued','leased','retry_wait','failed_terminal')
      ORDER BY r.sequence_start,r.extraction_run_id LIMIT 1; END IF;
  result_run:=result_run-'lease_token'-'lease_owner'-'lease_expires_at'-'extractor_input_context';
  receipt:=jsonb_build_object('schema','mem00.source-target-at-epoch.v1','event_id',target_event_id,'run',result_run,
    'invalidated_count',cardinality(candidate_ids),'source_manifest_ref',p_target_manifest_ref,'idempotent_replay',false,
    'historical_result_only',true,'memory_clear_epoch',p_expected_clear_epoch,'source_snapshot',snapshot,
    'source_target',public.sophia_memory_source_snapshot(p_user_id,p_session_id,p_thread_id),
    'extractor_contract_version',p_extractor_contract_version);
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,
    actor_kind,safe_reason_code,source_session_id,source_target_receipt)
    VALUES(target_event_id,'memop-'||replace(target_event_id::text,'-',''),p_idempotency_key,p_request_digest,p_user_id,
      'source_target_at_epoch_aligned','system','exact_current_epoch_source',p_session_id,receipt);
  RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_epoch_target_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.event_type='source_target_at_epoch_aligned' THEN
    IF TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'memory_source_target_receipt_immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_epoch_target_receipt_immutable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_epoch_target_receipt_immutable BEFORE UPDATE OR DELETE ON public.sophia_memory_governance_events
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_epoch_target_receipt_immutable();
REVOKE ALL ON FUNCTION public.sophia_memory_source_snapshot(text,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_apply_source_target_at_epoch(text,text,text,bigint,text,jsonb,jsonb,jsonb,text,text,text,text,timestamptz,text,text,bigint,jsonb),
  public.sophia_memory_epoch_target_receipt_immutable() FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
