-- C1 staged additive source/dependency contract. Production approval required.
-- Apply before 2026_09_09_mem00_c1_review_snapshot.sql (also lexical order).
-- Canonical authority only; no provider, SDK, model or billing configuration.
BEGIN;

ALTER TABLE public.sophia_memory_user_governance
  ADD COLUMN IF NOT EXISTS source_recovery_state jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.sophia_memory_governance_events
  ADD COLUMN IF NOT EXISTS source_recovery_receipt jsonb;
CREATE INDEX IF NOT EXISTS sophia_memory_recovery_sessions
  ON public.sophia_sessions(user_id,id) WHERE status='ended';

ALTER TABLE public.sophia_session_messages
  ADD COLUMN IF NOT EXISTS memory_source_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.sophia_memory_extraction_runs
  ADD COLUMN IF NOT EXISTS source_dependencies jsonb,
  ADD COLUMN IF NOT EXISTS validated_transcript_revision bigint,
  ADD COLUMN IF NOT EXISTS extractor_input_context jsonb,
  ADD COLUMN IF NOT EXISTS extractor_input_ref text;
ALTER TABLE public.sophia_memory_governance_events
  ADD COLUMN IF NOT EXISTS source_session_id text,
  ADD COLUMN IF NOT EXISTS source_fence boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_target_receipt jsonb;
CREATE INDEX IF NOT EXISTS sophia_memory_source_fences
  ON public.sophia_memory_governance_events(user_id,source_session_id) WHERE source_fence;

-- Distinguish a changed full input even when the transcript revision is stable.
-- Existing historical rows retain their old uniqueness and remain unproven.
DO $migration$
DECLARE item record;
BEGIN
  FOR item IN SELECT c.conname FROM pg_constraint c WHERE c.conrelid='public.sophia_memory_extraction_runs'::regclass AND c.contype='u'
    AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=
      ARRAY['user_id','session_id','transcript_revision','sequence_start','sequence_end','extractor_contract_version'] LOOP
    EXECUTE format('ALTER TABLE public.sophia_memory_extraction_runs DROP CONSTRAINT %I',item.conname);
  END LOOP;
END $migration$;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_extraction_legacy_input_unique ON public.sophia_memory_extraction_runs
  (user_id,session_id,transcript_revision,sequence_start,sequence_end,extractor_contract_version) WHERE extractor_input_ref IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_extraction_full_input_unique ON public.sophia_memory_extraction_runs
  (user_id,session_id,transcript_revision,sequence_start,sequence_end,extractor_contract_version,extractor_input_ref) WHERE extractor_input_ref IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sophia_memory_extraction_input_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.extractor_input_ref IS NOT NULL AND
    ROW(NEW.user_id,NEW.session_id,NEW.thread_id,NEW.transcript_revision,NEW.sequence_start,NEW.sequence_end,
      NEW.input_manifest_ref,NEW.source_dependencies,NEW.extractor_contract_version,NEW.extractor_model,
      NEW.extractor_prompt_version,NEW.extractor_input_context,NEW.extractor_input_ref)
    IS DISTINCT FROM ROW(OLD.user_id,OLD.session_id,OLD.thread_id,OLD.transcript_revision,OLD.sequence_start,OLD.sequence_end,
      OLD.input_manifest_ref,OLD.source_dependencies,OLD.extractor_contract_version,OLD.extractor_model,
      OLD.extractor_prompt_version,OLD.extractor_input_context,OLD.extractor_input_ref) THEN
    RAISE EXCEPTION 'memory_extractor_input_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_extraction_input_immutable ON public.sophia_memory_extraction_runs;
CREATE TRIGGER sophia_memory_extraction_input_immutable BEFORE UPDATE ON public.sophia_memory_extraction_runs
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_extraction_input_immutable();

CREATE OR REPLACE FUNCTION public.sophia_memory_run_input_valid(p_user_id text,p_session_id text,p_context jsonb,p_input_ref text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  RETURN coalesce(jsonb_typeof(p_context)='object' AND (SELECT count(*) FROM jsonb_object_keys(p_context))=4
    AND p_context->>'schema'='mem00.extract-input.v1'
    AND jsonb_typeof(p_context->'context_mode')='string' AND length(p_context->>'context_mode') BETWEEN 1 AND 512
    AND p_context->>'session_date' ~ '^\d{4}-\d{2}-\d{2}$' AND to_char((p_context->>'session_date')::date,'YYYY-MM-DD')=p_context->>'session_date'
    AND p_context->>'template_sha256' ~ '^[a-f0-9]{64}$' AND p_input_ref ~ '^hmac-sha256:extractor-input:[a-f0-9]{64}$'
    AND EXISTS(SELECT 1 FROM public.sophia_sessions s WHERE s.user_id=p_user_id AND s.id=p_session_id
      AND coalesce(nullif(to_jsonb(s)->'metadata'->>'context_mode',''),'life')=p_context->>'context_mode'),false);
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_source_version_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN NEW.memory_source_version:=gen_random_uuid();
  ELSIF (to_jsonb(NEW)-'memory_source_version') IS DISTINCT FROM (to_jsonb(OLD)-'memory_source_version') THEN
    NEW.memory_source_version:=gen_random_uuid();
  ELSE NEW.memory_source_version:=OLD.memory_source_version;
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_source_version ON public.sophia_session_messages;
CREATE TRIGGER sophia_memory_source_version BEFORE INSERT OR UPDATE ON public.sophia_session_messages
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_source_version_trigger();

CREATE OR REPLACE FUNCTION public.sophia_memory_source_fenced(p_user_id text,p_session_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
SELECT EXISTS(SELECT 1 FROM public.sophia_memory_governance_events
 WHERE user_id=p_user_id AND source_session_id=p_session_id AND source_fence)
$fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_run_source_valid(
  p_user_id text,p_session_id text,p_start bigint,p_end bigint,p_dependencies jsonb
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
SELECT CASE WHEN jsonb_typeof(p_dependencies) IS DISTINCT FROM 'array' THEN false ELSE
  NOT public.sophia_memory_source_fenced(p_user_id,p_session_id)
  AND jsonb_array_length(p_dependencies)>0 AND jsonb_array_length(p_dependencies)<=10000
  AND EXISTS(SELECT 1 FROM public.sophia_sessions WHERE id=p_session_id AND user_id=p_user_id)
  AND jsonb_array_length(p_dependencies)=(SELECT count(DISTINCT d->>'message_id') FROM jsonb_array_elements(p_dependencies) d)
  AND jsonb_array_length(p_dependencies)=(SELECT count(*) FROM public.sophia_session_messages m
    WHERE m.user_id=p_user_id AND m.session_id=p_session_id AND m.sequence BETWEEN p_start AND p_end
      AND m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>'')
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_dependencies) d WHERE NOT EXISTS(
    SELECT 1 FROM public.sophia_session_messages m WHERE m.user_id=p_user_id AND m.session_id=p_session_id
      AND m.message_id=d->>'message_id' AND m.sequence=(d->>'sequence')::bigint
      AND m.sequence BETWEEN p_start AND p_end AND m.memory_source_version=(d->>'source_version')::uuid
      AND m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>'')) END
$fn$;

-- A source-delete decision fences future producers even before physical parent
-- deletion, and remains fenced if an old session ID is accidentally recreated.
DO $migration$
BEGIN
  IF to_regprocedure('public.sophia_memory_invalidate_source_pre_c1(text,text,bigint,boolean,text,text,text,text)') IS NULL THEN
    ALTER FUNCTION public.sophia_memory_invalidate_source(text,text,bigint,boolean,text,text,text,text)
      RENAME TO sophia_memory_invalidate_source_pre_c1;
  END IF;
END $migration$;
CREATE OR REPLACE FUNCTION public.sophia_memory_invalidate_source(
  p_user_id text,p_session_id text,p_current_transcript_revision bigint,p_detach_source boolean,
  p_actor_kind text,p_idempotency_key text,p_request_digest text,p_safe_reason_code text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE receipt jsonb;
BEGIN
  PERFORM public.sophia_memory_ensure_governance(p_user_id);
  PERFORM 1 FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id FOR UPDATE;
  receipt:=public.sophia_memory_invalidate_source_pre_c1(p_user_id,p_session_id,p_current_transcript_revision,
    p_detach_source,p_actor_kind,p_idempotency_key,p_request_digest,p_safe_reason_code);
  UPDATE public.sophia_memory_governance_events SET source_session_id=p_session_id,source_fence=p_detach_source
    WHERE user_id=p_user_id AND event_id=(receipt->>'event_id')::uuid;
  RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_apply_source_target(
  p_user_id text,p_session_id text,p_thread_id text,p_transcript_revision bigint,
  p_target_manifest_ref text,p_observed_runs jsonb,p_reused_runs jsonb,p_next_range jsonb,
  p_extractor_contract_version text,p_extractor_model text,p_extractor_prompt_version text,
  p_modality text,p_ended_at timestamptz,p_idempotency_key text,p_request_digest text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE parent public.sophia_sessions; run public.sophia_memory_extraction_runs;
  witness jsonb; actual jsonb; previous_event public.sophia_memory_governance_events;
  invalidated uuid[]:=ARRAY[]::uuid[]; candidate_ids uuid[]:=ARRAY[]::uuid[];
  first_sequence bigint; last_sequence bigint; dependencies jsonb; result_run jsonb:=NULL;
  target_event_id uuid:=gen_random_uuid();
  receipt jsonb;
BEGIN
  -- Common serialization: owner, parent, then run/candidate rows. No network.
  PERFORM public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO previous_event FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF previous_event.request_digest<>p_request_digest OR previous_event.source_target_receipt IS NULL THEN
      RAISE EXCEPTION 'memory_idempotency_digest_conflict' USING ERRCODE='23505';
    END IF;
    RETURN previous_event.source_target_receipt || jsonb_build_object('idempotent_replay',true);
  END IF;
  SELECT * INTO STRICT parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id FOR UPDATE;
  IF parent.thread_id<>p_thread_id OR parent.message_revision<>p_transcript_revision
     OR public.sophia_memory_source_fenced(p_user_id,p_session_id) THEN
    RAISE EXCEPTION 'memory_source_target_conflict' USING ERRCODE='40001';
  END IF;
  -- The complete observed set is CAS-checked: no first-page inference or mixed
  -- observation can invalidate a run that was not part of the planning view.
  SELECT coalesce(jsonb_agg(jsonb_build_object('extraction_run_id',extraction_run_id,'state',state,
    'input_manifest_ref',input_manifest_ref) ORDER BY extraction_run_id),'[]'::jsonb)
    INTO actual FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND session_id=p_session_id AND state<>'superseded';
  IF actual IS DISTINCT FROM p_observed_runs THEN RAISE EXCEPTION 'memory_source_runs_changed' USING ERRCODE='40001'; END IF;
  IF jsonb_typeof(p_reused_runs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_reused_runs)>10000
     OR jsonb_array_length(p_reused_runs)<>(SELECT count(DISTINCT x->>'extraction_run_id') FROM jsonb_array_elements(p_reused_runs) x) THEN
    RAISE EXCEPTION 'memory_source_witness_invalid';
  END IF;
  FOR witness IN SELECT value FROM jsonb_array_elements(p_reused_runs) LOOP
    SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
      WHERE user_id=p_user_id AND session_id=p_session_id AND extraction_run_id=(witness->>'extraction_run_id')::uuid FOR UPDATE;
    IF run.state='superseded' OR run.input_manifest_ref IS DISTINCT FROM witness->>'input_manifest_ref'
       OR run.extractor_contract_version<>p_extractor_contract_version
       OR run.extractor_model<>p_extractor_model OR run.extractor_prompt_version<>p_extractor_prompt_version
       OR NOT public.sophia_memory_run_source_valid(p_user_id,p_session_id,run.sequence_start,run.sequence_end,witness->'dependencies')
       OR run.source_dependencies IS DISTINCT FROM witness->'dependencies'
       OR run.extractor_input_ref IS DISTINCT FROM witness->>'extractor_input_ref'
       OR run.extractor_input_context IS DISTINCT FROM witness->'extractor_input_context'
       OR NOT public.sophia_memory_run_input_valid(p_user_id,p_session_id,run.extractor_input_context,run.extractor_input_ref) THEN
      RAISE EXCEPTION 'memory_source_witness_invalid' USING ERRCODE='40001';
    END IF;
    UPDATE public.sophia_memory_extraction_runs SET source_dependencies=witness->'dependencies',
      validated_transcript_revision=p_transcript_revision,updated_at=now() WHERE extraction_run_id=run.extraction_run_id;
  END LOOP;
  SELECT coalesce(array_agg(extraction_run_id),ARRAY[]::uuid[]) INTO invalidated
    FROM public.sophia_memory_extraction_runs r WHERE user_id=p_user_id AND session_id=p_session_id AND state<>'superseded'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_reused_runs) w WHERE (w->>'extraction_run_id')::uuid=r.extraction_run_id);
  SELECT coalesce(array_agg(candidate_id),ARRAY[]::uuid[]) INTO candidate_ids
    FROM public.sophia_memory_candidates WHERE user_id=p_user_id AND extraction_run_id=ANY(invalidated) AND review_state='pending_review';
  UPDATE public.sophia_memory_candidates SET review_state='expired',expired_at=now(),scrubbed_at=now() WHERE candidate_id=ANY(candidate_ids);
  UPDATE public.sophia_memory_candidate_versions SET proposed_content=NULL,content_ref=NULL,scrubbed_at=now()
    WHERE user_id=p_user_id AND candidate_id=ANY(candidate_ids) AND scrubbed_at IS NULL;
  UPDATE public.sophia_memory_candidate_sources SET invalidated_at=coalesce(invalidated_at,now()),detached_at=coalesce(detached_at,now())
    WHERE user_id=p_user_id AND candidate_id IN (SELECT candidate_id FROM public.sophia_memory_candidates WHERE extraction_run_id=ANY(invalidated));
  UPDATE public.sophia_memory_versions v SET source_link_manifest=coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(v.source_link_manifest) x WHERE x->>'session_id'<>p_session_id),'[]'::jsonb)
    WHERE v.user_id=p_user_id AND v.memory_id IN (SELECT m.memory_id FROM public.sophia_memories m JOIN public.sophia_memory_candidates c ON c.candidate_id=m.origin_candidate_id AND c.user_id=m.user_id WHERE c.extraction_run_id=ANY(invalidated));
  UPDATE public.sophia_memory_extraction_runs SET state='superseded',validated_transcript_revision=p_transcript_revision,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,terminal_at=coalesce(terminal_at,now()),updated_at=now(),safe_terminal_reason='source_dependency_changed'
    WHERE extraction_run_id=ANY(invalidated);
  -- Find one bounded contiguous uncovered range; later completions/recovery
  -- continue the target. The old sequence watermark is never coverage proof.
  WITH target AS (SELECT m.sequence,EXISTS(SELECT 1 FROM public.sophia_memory_extraction_runs r
    WHERE r.user_id=p_user_id AND r.session_id=p_session_id AND r.state<>'superseded'
      AND r.validated_transcript_revision=p_transcript_revision AND m.sequence BETWEEN r.sequence_start AND r.sequence_end) AS reserved
    FROM public.sophia_session_messages m WHERE m.user_id=p_user_id AND m.session_id=p_session_id
      AND m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>'')
  SELECT min(sequence) FILTER(WHERE NOT reserved) INTO first_sequence FROM target;
  IF first_sequence IS NOT NULL THEN
    SELECT max(m.sequence) INTO last_sequence FROM public.sophia_session_messages m
      WHERE m.user_id=p_user_id AND m.session_id=p_session_id AND m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>''
        AND m.sequence>=first_sequence AND m.sequence<coalesce((SELECT min(r.sequence_start) FROM public.sophia_memory_extraction_runs r
          WHERE r.user_id=p_user_id AND r.session_id=p_session_id AND r.state<>'superseded'
            AND r.validated_transcript_revision=p_transcript_revision AND r.sequence_start>first_sequence),9223372036854775807);
    IF p_next_range IS NULL OR (p_next_range->>'sequence_start')::bigint<>first_sequence OR (p_next_range->>'sequence_end')::bigint<>last_sequence THEN
      RAISE EXCEPTION 'memory_source_range_conflict' USING ERRCODE='40001';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('message_id',message_id,'sequence',sequence,'source_version',memory_source_version) ORDER BY sequence,message_id)
      INTO dependencies FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id
        AND sequence BETWEEN first_sequence AND last_sequence AND final AND role IN ('user','assistant') AND btrim(content)<>'';
    IF NOT public.sophia_memory_run_input_valid(p_user_id,p_session_id,p_next_range->'extractor_input_context',p_next_range->>'extractor_input_ref') THEN
      RAISE EXCEPTION 'memory_extractor_input_invalid' USING ERRCODE='40001';
    END IF;
    INSERT INTO public.sophia_memory_extraction_runs(user_id,idempotency_key,request_digest,session_id,thread_id,modality,
      transcript_revision,sequence_start,sequence_end,input_manifest_ref,extractor_contract_version,extractor_model,extractor_prompt_version,
      source_dependencies,validated_transcript_revision,extractor_input_context,extractor_input_ref)
    VALUES(p_user_id,p_idempotency_key||':range',p_request_digest,p_session_id,p_thread_id,p_modality,p_transcript_revision,
      first_sequence,last_sequence,p_next_range->>'input_manifest_ref',p_extractor_contract_version,p_extractor_model,p_extractor_prompt_version,
      dependencies,p_transcript_revision,p_next_range->'extractor_input_context',p_next_range->>'extractor_input_ref') RETURNING * INTO run;
    result_run:=to_jsonb(run);
  ELSIF p_next_range IS NOT NULL THEN RAISE EXCEPTION 'memory_source_range_conflict' USING ERRCODE='40001';
  END IF;
  IF p_ended_at IS NOT NULL THEN UPDATE public.sophia_sessions SET status='ended',ended_at=coalesce(ended_at,p_ended_at),updated_at=now() WHERE user_id=p_user_id AND id=p_session_id; END IF;
  IF previous_event.event_id IS NULL THEN
    INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,safe_reason_code,source_session_id)
      VALUES(target_event_id,'memop-'||replace(target_event_id::text,'-',''),p_idempotency_key,p_request_digest,p_user_id,'source_target_aligned','system','exact_source_dependencies',p_session_id);
  ELSE target_event_id:=previous_event.event_id;
  END IF;
  IF result_run IS NULL THEN SELECT to_jsonb(r) INTO result_run FROM public.sophia_memory_extraction_runs r
    WHERE r.user_id=p_user_id AND r.session_id=p_session_id AND r.validated_transcript_revision=p_transcript_revision
      AND r.state IN ('queued','leased','retry_wait','failed_terminal') ORDER BY r.sequence_start,r.extraction_run_id LIMIT 1; END IF;
  result_run:=result_run-'lease_token'-'lease_owner'-'lease_expires_at'-'extractor_input_context';
  receipt:=jsonb_build_object('event_id',target_event_id,'run',result_run,'invalidated_count',cardinality(candidate_ids),'source_manifest_ref',p_target_manifest_ref,'idempotent_replay',false,
    'source_target',jsonb_build_object('owner_id',p_user_id,'session_id',p_session_id,'thread_id',p_thread_id,
      'transcript_revision',p_transcript_revision,'source_manifest_ref',p_target_manifest_ref,
      'source_dependencies',(SELECT coalesce(jsonb_agg(jsonb_build_object('message_id',message_id,'sequence',sequence,
        'source_version',memory_source_version) ORDER BY sequence,message_id),'[]'::jsonb)
        FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id
          AND final AND role IN ('user','assistant') AND btrim(content)<>''),
      'extractor_contract_version',p_extractor_contract_version,
      'status',CASE WHEN p_ended_at IS NOT NULL THEN 'ended' ELSE parent.status END,
      'ended_at',coalesce(parent.ended_at,p_ended_at),
      'sequence_start',(SELECT min(sequence) FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id AND final AND role IN ('user','assistant') AND btrim(content)<>''),
      'sequence_end',(SELECT max(sequence) FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id AND final AND role IN ('user','assistant') AND btrim(content)<>''),
      'message_count',(SELECT count(*) FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id AND final AND role IN ('user','assistant') AND btrim(content)<>'')));
  UPDATE public.sophia_memory_governance_events SET source_target_receipt=receipt WHERE user_id=p_user_id AND sophia_memory_governance_events.event_id=target_event_id;
  RETURN receipt;
END $fn$;

-- Keep receipt-first semantics for already committed approvals. New approvals
-- additionally serialize against and validate the complete original input.
CREATE OR REPLACE FUNCTION public.sophia_memory_assert_candidate_source(p_user_id text,p_candidate_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE run public.sophia_memory_extraction_runs; candidate public.sophia_memory_candidates;
BEGIN
  SELECT * INTO STRICT candidate FROM public.sophia_memory_candidates WHERE user_id=p_user_id AND candidate_id=p_candidate_id;
  SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND extraction_run_id=candidate.extraction_run_id;
  PERFORM 1 FROM public.sophia_sessions WHERE user_id=p_user_id AND id=run.session_id FOR UPDATE;
  IF NOT FOUND OR candidate.created_at<=now()-interval '30 days' OR run.state NOT IN ('succeeded_zero','succeeded_nonzero')
    OR NOT public.sophia_memory_run_source_valid(p_user_id,run.session_id,run.sequence_start,run.sequence_end,run.source_dependencies)
    OR NOT public.sophia_memory_run_input_valid(p_user_id,run.session_id,run.extractor_input_context,run.extractor_input_ref)
    OR (SELECT count(*) FROM public.sophia_memory_candidate_sources WHERE user_id=p_user_id AND candidate_id=p_candidate_id)<>jsonb_array_length(run.source_dependencies)
    OR EXISTS(SELECT 1 FROM public.sophia_memory_candidate_sources cs WHERE cs.user_id=p_user_id AND cs.candidate_id=p_candidate_id
      AND (cs.session_id IS DISTINCT FROM run.session_id OR cs.transcript_revision IS DISTINCT FROM run.transcript_revision
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.source_dependencies) d
          WHERE d->>'message_id'=cs.message_id AND (d->>'sequence')::bigint=cs.sequence)))
    OR EXISTS(SELECT 1 FROM public.sophia_memory_candidate_sources WHERE user_id=p_user_id AND candidate_id=p_candidate_id AND (invalidated_at IS NOT NULL OR detached_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'memory_candidate_source_ineligible' USING ERRCODE='40001';
  END IF;
END $fn$;
DO $migration$
DECLARE definition text; rewritten text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname='sophia_memory_approve_candidate';
  IF position('-- MEM00_C1_SOURCE_APPROVAL' IN definition)=0 THEN
    IF position('new_candidate_revision := p_expected_candidate_revision;' IN definition)=0 THEN RAISE EXCEPTION 'memory_source_approval_baseline_mismatch'; END IF;
    rewritten:=replace(definition,'new_candidate_revision := p_expected_candidate_revision;',E'-- MEM00_C1_SOURCE_APPROVAL\n    PERFORM public.sophia_memory_assert_candidate_source(p_user_id,p_candidate_id);\n    new_candidate_revision := p_expected_candidate_revision;');
    EXECUTE rewritten;
  END IF;
  IF to_regprocedure('public.sophia_memory_complete_extraction_pre_c1(text,uuid,uuid,text,jsonb)') IS NULL THEN
    SELECT pg_get_functiondef('public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb)'::regprocedure) INTO definition;
    IF position('AND message_revision = run.transcript_revision;' IN definition)=0 THEN RAISE EXCEPTION 'memory_source_completion_baseline_mismatch'; END IF;
    -- Parent and dependencies are checked by the wrapper, not whole revision.
    EXECUTE replace(definition,'AND message_revision = run.transcript_revision;',';');
    ALTER FUNCTION public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb) RENAME TO sophia_memory_complete_extraction_pre_c1;
  END IF;
END $migration$;
CREATE OR REPLACE FUNCTION public.sophia_memory_complete_extraction(p_user_id text,p_extraction_run_id uuid,p_lease_token uuid,p_input_manifest_ref text,p_candidates jsonb)
RETURNS public.sophia_memory_extraction_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE run public.sophia_memory_extraction_runs; candidate jsonb; expected_sources jsonb; actual_sources jsonb;
BEGIN
  PERFORM public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND extraction_run_id=p_extraction_run_id;
  PERFORM 1 FROM public.sophia_sessions WHERE user_id=p_user_id AND id=run.session_id FOR UPDATE;
  IF NOT FOUND OR NOT public.sophia_memory_run_source_valid(p_user_id,run.session_id,run.sequence_start,run.sequence_end,run.source_dependencies)
    OR NOT public.sophia_memory_run_input_valid(p_user_id,run.session_id,run.extractor_input_context,run.extractor_input_ref) THEN
    RAISE EXCEPTION 'memory_extraction_source_ineligible' USING ERRCODE='40001';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('message_id',d->>'message_id','sequence',(d->>'sequence')::bigint,
      'session_id',run.session_id,'transcript_revision',run.transcript_revision) ORDER BY (d->>'sequence')::bigint,d->>'message_id')
    INTO expected_sources FROM jsonb_array_elements(run.source_dependencies) d;
  FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates) LOOP
    IF jsonb_typeof(candidate->'sources') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'memory_extraction_candidate_sources_invalid' USING ERRCODE='40001';
    END IF;
    SELECT jsonb_agg(jsonb_build_object('message_id',d->>'message_id','sequence',(d->>'sequence')::bigint,
        'session_id',d->>'session_id','transcript_revision',(d->>'transcript_revision')::bigint)
        ORDER BY (d->>'sequence')::bigint,d->>'message_id') INTO actual_sources FROM jsonb_array_elements(candidate->'sources') d;
    IF actual_sources IS DISTINCT FROM expected_sources THEN
      RAISE EXCEPTION 'memory_extraction_candidate_sources_invalid' USING ERRCODE='40001';
    END IF;
  END LOOP;
  RETURN public.sophia_memory_complete_extraction_pre_c1(p_user_id,p_extraction_run_id,p_lease_token,p_input_manifest_ref,p_candidates);
END $fn$;

-- Retention belongs to existing governed owners, independent of producer flags
-- or disabled serving mode. Unknown/legacy histories are not auto-enrolled or
-- destroyed. A missing/incompatible contract denies the entire operation.
CREATE OR REPLACE FUNCTION public.sophia_memory_expire_governed_candidates(p_limit integer DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE affected integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>5000 THEN
    RAISE EXCEPTION 'memory_expiry_limit_invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1' AND contract_epoch=1) THEN
    RAISE EXCEPTION 'memory_retention_contract_incompatible' USING ERRCODE='42501';
  END IF;
  WITH expired AS (
    SELECT c.user_id,c.candidate_id FROM public.sophia_memory_candidates c
      JOIN public.sophia_memory_user_governance g ON g.user_id=c.user_id
      WHERE g.authority_state='governed' AND g.authority_epoch=1
        AND c.review_state='pending_review' AND c.created_at<=now()-interval '30 days'
      ORDER BY c.created_at,c.candidate_id FOR UPDATE OF c SKIP LOCKED LIMIT p_limit
  ), scrubbed AS (
    UPDATE public.sophia_memory_candidate_versions v SET proposed_content=NULL,content_ref=NULL,scrubbed_at=now()
      FROM expired WHERE v.user_id=expired.user_id AND v.candidate_id=expired.candidate_id
      RETURNING v.candidate_id
  ) UPDATE public.sophia_memory_candidates c SET review_state='expired',expired_at=now(),scrubbed_at=now()
      FROM expired WHERE c.user_id=expired.user_id AND c.candidate_id=expired.candidate_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_expire_governed_candidates(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_expire_governed_candidates(integer) TO service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_expire_candidates(integer) FROM service_role;

-- One leased source at a time per existing owner row. Committed cursor + fixed
-- outcome receipts survive process loss. A scan end is NOT extraction success:
-- failures remain counted and every source is revisited in a later sweep.
CREATE OR REPLACE FUNCTION public.sophia_memory_claim_source_recovery(p_user_id text,p_lease_owner text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE owner_row public.sophia_memory_user_governance; state jsonb; source_id text;
  sweep_id uuid; token uuid; receipt jsonb;
BEGIN
  IF p_lease_owner IS NULL OR length(p_lease_owner) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION 'memory_recovery_worker_invalid' USING ERRCODE='22023';
  END IF;
  owner_row:=public.sophia_memory_ensure_governance(p_user_id);
  IF NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract WHERE singleton AND mode IN ('shadow','enforced')) THEN
    RAISE EXCEPTION 'memory_contract_not_active' USING ERRCODE='42501';
  END IF;
  state:=owner_row.source_recovery_state;
  IF (state->>'next_scan_at')::timestamptz>now() OR (state->>'lease_expires_at')::timestamptz>now() THEN RETURN NULL; END IF;
  sweep_id:=coalesce((state->>'sweep_id')::uuid,gen_random_uuid());
  source_id:=state->>'lease_session_id';
  IF source_id IS NULL THEN
    SELECT id INTO source_id FROM public.sophia_sessions
      WHERE user_id=p_user_id AND status='ended' AND (state->>'after_session_id' IS NULL OR id>state->>'after_session_id')
      ORDER BY id LIMIT 1;
  END IF;
  IF source_id IS NULL THEN
    receipt:=jsonb_build_object('schema','mem00.source-recovery.v1','user_id',p_user_id,'sweep_id',sweep_id,
      'outcome','scan_observed_end','checked',coalesce((state->>'checked')::int,0),
      'unavailable',coalesce((state->>'unavailable')::int,0),'observed_at',now(),
      'scope','enumeration_only','extraction_complete',false);
    INSERT INTO public.sophia_memory_governance_events(operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,source_recovery_receipt)
      VALUES(sweep_id::text,'source-recovery-sweep:'||sweep_id::text,md5(receipt::text),p_user_id,'source_recovery_scan_observed_end','system',receipt);
    UPDATE public.sophia_memory_user_governance SET source_recovery_state=jsonb_build_object(
      'sweep_id',gen_random_uuid(),'checked',0,'unavailable',0,'next_scan_at',now()+interval '60 seconds') WHERE user_id=p_user_id;
    RETURN NULL;
  END IF;
  token:=gen_random_uuid();
  state:=(state-'next_scan_at')||jsonb_build_object('sweep_id',sweep_id,'lease_session_id',source_id,
    'lease_token',token,'lease_owner',p_lease_owner,'lease_expires_at',now()+interval '5 minutes');
  UPDATE public.sophia_memory_user_governance SET source_recovery_state=state WHERE user_id=p_user_id;
  RETURN jsonb_build_object('user_id',p_user_id,'session_id',source_id,'sweep_id',sweep_id,
    'lease_token',token,'lease_owner',p_lease_owner,'lease_expires_at',state->'lease_expires_at');
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_complete_source_recovery(
  p_user_id text,p_session_id text,p_sweep_id uuid,p_lease_token uuid,p_lease_owner text,p_outcome text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE owner_row public.sophia_memory_user_governance; state jsonb; receipt jsonb; prior jsonb;
  op_key text:='source-recovery:'||p_lease_token::text; digest text;
BEGIN
  IF p_session_id IS NULL OR p_lease_token IS NULL OR p_sweep_id IS NULL OR p_lease_owner IS NULL
    OR p_outcome IS NULL OR p_outcome NOT IN ('target_checked','source_ineligible','retryable_failure') THEN
    RAISE EXCEPTION 'memory_recovery_outcome_invalid' USING ERRCODE='22023';
  END IF;
  owner_row:=public.sophia_memory_ensure_governance(p_user_id);
  digest:=md5(jsonb_build_array(p_user_id,p_session_id,p_sweep_id,p_lease_token,p_lease_owner,p_outcome)::text);
  SELECT source_recovery_receipt INTO prior FROM public.sophia_memory_governance_events
    WHERE user_id=p_user_id AND idempotency_key=op_key AND request_digest=digest;
  IF FOUND THEN RETURN prior||jsonb_build_object('idempotent_replay',true); END IF;
  IF EXISTS(SELECT 1 FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=op_key) THEN
    RAISE EXCEPTION 'memory_idempotency_digest_conflict' USING ERRCODE='23505';
  END IF;
  state:=owner_row.source_recovery_state;
  IF state->>'lease_session_id' IS DISTINCT FROM p_session_id OR state->>'lease_owner' IS DISTINCT FROM p_lease_owner
    OR (state->>'sweep_id')::uuid IS DISTINCT FROM p_sweep_id OR (state->>'lease_token')::uuid IS DISTINCT FROM p_lease_token
    OR (coalesce((state->>'lease_expires_at')::timestamptz<=now(),true) AND p_outcome<>'retryable_failure') THEN
    RAISE EXCEPTION 'memory_recovery_lease_stale' USING ERRCODE='40001';
  END IF;
  -- An expired but unreplaced token may acknowledge failure only. This cannot
  -- authorize extraction/model work or a successful result. A replaced token
  -- still fails above; the next sweep revisits this unresolved source.
  receipt:=jsonb_build_object('schema','mem00.source-recovery.v1','user_id',p_user_id,'session_id',p_session_id,
    'sweep_id',p_sweep_id,'lease_token',p_lease_token,'outcome',p_outcome,'checked_at',now(),
    'extraction_complete',false,'idempotent_replay',false);
  INSERT INTO public.sophia_memory_governance_events(operation_id,idempotency_key,request_digest,user_id,event_type,actor_kind,source_session_id,source_recovery_receipt)
    VALUES(p_lease_token::text,op_key,digest,p_user_id,'source_recovery_checked','system',p_session_id,receipt);
  UPDATE public.sophia_memory_user_governance SET source_recovery_state=
    (state-ARRAY['lease_session_id','lease_token','lease_owner','lease_expires_at'])||jsonb_build_object(
      'after_session_id',p_session_id,'checked',coalesce((state->>'checked')::int,0)+1,
      'unavailable',coalesce((state->>'unavailable')::int,0)+CASE WHEN p_outcome='target_checked' THEN 0 ELSE 1 END)
    WHERE user_id=p_user_id;
  RETURN receipt;
END $fn$;

REVOKE ALL ON FUNCTION public.sophia_memory_claim_source_recovery(text,text),
  public.sophia_memory_complete_source_recovery(text,text,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_claim_source_recovery(text,text),
  public.sophia_memory_complete_source_recovery(text,text,uuid,uuid,text,text) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_memory_source_version_trigger(),public.sophia_memory_source_fenced(text,text),
  public.sophia_memory_extraction_input_immutable(),
  public.sophia_memory_run_input_valid(text,text,jsonb,text),
  public.sophia_memory_run_source_valid(text,text,bigint,bigint,jsonb),public.sophia_memory_assert_candidate_source(text,uuid),
  public.sophia_memory_invalidate_source_pre_c1(text,text,bigint,boolean,text,text,text,text),
  public.sophia_memory_complete_extraction_pre_c1(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_apply_source_target(text,text,text,bigint,text,jsonb,jsonb,jsonb,text,text,text,text,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_apply_source_target(text,text,text,bigint,text,jsonb,jsonb,jsonb,text,text,text,text,timestamptz,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_enqueue_extraction(text,text,text,text,text,text,bigint,bigint,bigint,text,text,text,text),
  public.sophia_memory_finalize_and_enqueue_extraction(text,text,text,timestamptz,text,text,text,bigint,bigint,bigint,text,text,text,text) FROM service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_invalidate_source(text,text,bigint,boolean,text,text,text,text),
  public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_invalidate_source(text,text,bigint,boolean,text,text,text,text),
  public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
