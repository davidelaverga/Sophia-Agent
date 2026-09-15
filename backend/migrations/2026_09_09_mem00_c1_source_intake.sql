-- Ninth C1 stage. No application grants or automatic owner enrollment.
-- Apply after transactional_clear; source/UI/planner closure is still required.
BEGIN;
ALTER TABLE public.sophia_session_messages ADD COLUMN IF NOT EXISTS memory_source_accepted_version uuid;
ALTER TABLE public.sophia_memory_governance_events ADD COLUMN IF NOT EXISTS source_intake_receipt jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_source_intake_row_identity
  ON public.sophia_memory_governance_events((source_intake_receipt->>'source_row_id')) WHERE source_intake_receipt IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_source_intake_message_identity
  ON public.sophia_memory_governance_events(user_id,source_session_id,(source_intake_receipt->>'message_id')) WHERE source_intake_receipt IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sophia_memory_source_intake_version_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='INSERT' THEN
    -- Runs AFTER the database source-version trigger. The existing epoch trigger
    -- allows nonzero epochs only to the table owner/fixed SECURITY DEFINER writer.
    NEW.memory_source_accepted_version:=CASE WHEN NEW.memory_source_acceptance_epoch>0 THEN NEW.memory_source_version ELSE NULL END;
  ELSIF NEW.memory_source_accepted_version IS DISTINCT FROM OLD.memory_source_accepted_version THEN
    RAISE EXCEPTION 'memory_source_accepted_version_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS zz_mem00_source_intake_version ON public.sophia_session_messages;
CREATE TRIGGER zz_mem00_source_intake_version BEFORE INSERT OR UPDATE ON public.sophia_session_messages
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_source_intake_version_trigger();

DO $migration$
DECLARE definition text; marker text:='AND m.memory_source_acceptance_epoch=(SELECT memory_clear_epoch FROM public.sophia_memory_user_governance WHERE user_id=p_user_id)';
BEGIN
  SELECT pg_get_functiondef('public.sophia_memory_run_source_valid(text,text,bigint,bigint,jsonb)'::regprocedure) INTO definition;
  IF strpos(definition,'MEM00_C1_EXACT_ACCEPTED_SOURCE_VERSION')=0 THEN
    IF md5(definition)<>'0d447ef95ed420e824d66bdc22380d69' OR strpos(definition,marker)=0 THEN
      RAISE EXCEPTION 'memory_source_predicate_drift';
    END IF;
    EXECUTE replace(definition,marker,marker||E'\n      -- MEM00_C1_EXACT_ACCEPTED_SOURCE_VERSION\n      AND (m.memory_source_acceptance_epoch=0 OR m.memory_source_accepted_version=m.memory_source_version)');
  END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.sophia_memory_source_intake_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.source_intake_receipt IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'memory_source_intake_receipt_immutable' USING ERRCODE='23514'; END IF;
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'memory_source_intake_receipt_immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_source_intake_receipt_immutable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_source_intake_receipt_immutable BEFORE UPDATE OR DELETE ON public.sophia_memory_governance_events
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_source_intake_receipt_immutable();

CREATE OR REPLACE FUNCTION public.sophia_memory_source_boundary(p_user_id text,p_session_id text,p_thread_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; parent public.sophia_sessions;
BEGIN
  SELECT * INTO governance FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR governance.authority_state<>'governed' OR NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract
    WHERE singleton AND schema_version='mem00.v1' AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced')) THEN
    RAISE EXCEPTION 'memory_source_authority_unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id FOR SHARE;
  IF NOT FOUND OR p_thread_id IS NULL OR parent.thread_id IS DISTINCT FROM p_thread_id OR parent.status IS NULL OR parent.status NOT IN ('active','resumable')
    OR coalesce(parent.metadata,'{}') ? 'synthetic_voice_lab' OR public.sophia_memory_source_fenced(p_user_id,p_session_id) THEN
    RAISE EXCEPTION 'memory_source_session_unavailable' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('schema','mem00.source-boundary.v1','owner_id',p_user_id,'session_id',p_session_id,
    'thread_id',p_thread_id,'memory_clear_epoch',governance.memory_clear_epoch,'transcript_revision',parent.message_revision);
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_accept_source_action(
  p_user_id text,p_session_id text,p_thread_id text,p_message_id text,p_source_row_id uuid,p_content text,
  p_expected_clear_epoch bigint,p_idempotency_key text,p_request_digest text,p_content_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; previous public.sophia_memory_governance_events;
  parent public.sophia_sessions; source_row public.sophia_session_messages;
  event uuid:=gen_random_uuid(); receipt jsonb; next_sequence bigint;
BEGIN
  IF p_expected_clear_epoch IS NULL OR p_expected_clear_epoch<0 OR p_source_row_id IS NULL OR p_session_id IS NULL OR p_thread_id IS NULL
    OR p_message_id IS NULL OR p_message_id !~ '^[A-Za-z0-9_-]{8,200}$'
    OR p_content IS NULL OR btrim(p_content)='' OR p_content<>btrim(p_content) OR octet_length(p_content)>1048576
    OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9_-]{8,200}$'
    OR p_request_digest IS NULL OR p_request_digest !~ '^hmac-sha256:request:[a-f0-9]{64}$'
    OR p_content_ref IS NULL OR p_content_ref !~ '^hmac-sha256:source-action-content:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'memory_source_action_invalid' USING ERRCODE='22023';
  END IF;
  -- Same lock order as clear and publication; no parent-first owner lock.
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO previous FROM public.sophia_memory_governance_events WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF previous.event_type<>'memory_source_action_accepted' OR previous.request_digest<>p_request_digest
      OR previous.source_intake_receipt IS NULL
      OR previous.source_intake_receipt->>'session_id' IS DISTINCT FROM p_session_id
      OR previous.source_intake_receipt->>'thread_id' IS DISTINCT FROM p_thread_id
      OR previous.source_intake_receipt->>'message_id' IS DISTINCT FROM p_message_id
      OR previous.source_intake_receipt->>'source_row_id' IS DISTINCT FROM p_source_row_id::text
      OR previous.source_intake_receipt->>'content_ref' IS DISTINCT FROM p_content_ref
      OR (previous.source_intake_receipt->>'memory_clear_epoch')::bigint IS DISTINCT FROM p_expected_clear_epoch THEN
      RAISE EXCEPTION 'memory_idempotency_digest_conflict' USING ERRCODE='23505';
    END IF;
    RETURN previous.source_intake_receipt||jsonb_build_object('idempotent_replay',true);
  END IF;
  PERFORM public.sophia_memory_source_boundary(p_user_id,p_session_id,p_thread_id);
  IF p_expected_clear_epoch IS DISTINCT FROM governance.memory_clear_epoch THEN
    RAISE EXCEPTION 'memory_clear_epoch_stale' USING ERRCODE='40001';
  END IF;
  SELECT * INTO STRICT parent FROM public.sophia_sessions WHERE user_id=p_user_id AND id=p_session_id FOR UPDATE;
  -- Recheck under the write lock (the boundary took a SHARE lock above).
  IF parent.thread_id IS DISTINCT FROM p_thread_id OR parent.status IS NULL OR parent.status NOT IN ('active','resumable')
    OR coalesce(parent.metadata,'{}') ? 'synthetic_voice_lab' THEN
    RAISE EXCEPTION 'memory_source_session_unavailable' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.sophia_session_messages WHERE id=p_source_row_id::text
    OR (user_id=p_user_id AND session_id=p_session_id AND message_id=p_message_id))
    OR EXISTS(SELECT 1 FROM public.sophia_memory_governance_events WHERE source_intake_receipt IS NOT NULL
      AND (source_intake_receipt->>'source_row_id'=p_source_row_id::text
        OR (user_id=p_user_id AND source_session_id=p_session_id AND source_intake_receipt->>'message_id'=p_message_id))) THEN
    RAISE EXCEPTION 'memory_source_occurrence_exists' USING ERRCODE='40001';
  END IF;
  SELECT coalesce(max(sequence),0)+1 INTO next_sequence FROM public.sophia_session_messages WHERE user_id=p_user_id AND session_id=p_session_id;
  INSERT INTO public.sophia_session_messages(id,message_id,session_id,user_id,thread_id,role,content,source,final,
    approximate,sequence,created_at,metadata,memory_source_acceptance_epoch)
  VALUES(p_source_row_id::text,p_message_id,p_session_id,p_user_id,p_thread_id,'user',p_content,'text',true,false,
    next_sequence,clock_timestamp(),'{"redaction_level":"none"}',governance.memory_clear_epoch) RETURNING * INTO source_row;
  UPDATE public.sophia_sessions SET message_revision=message_revision+1,transcript_available=true,updated_at=now()
    WHERE user_id=p_user_id AND id=p_session_id RETURNING * INTO parent;
  receipt:=jsonb_build_object('schema','mem00.source-action.v1','owner_id',p_user_id,'session_id',p_session_id,
    'thread_id',p_thread_id,'command_key',p_idempotency_key,'event_id',event,'message_id',p_message_id,
    'source_row_id',p_source_row_id,'source_version',source_row.memory_source_version,'sequence',source_row.sequence,
    'created_at',source_row.created_at,'memory_clear_epoch',governance.memory_clear_epoch,'transcript_revision',parent.message_revision,
    'content_ref',p_content_ref,'historical_result_only',true,'idempotent_replay',false,'status','source_recorded',
    'memory_approval','not_granted','current_extraction_eligibility','not_verified_in_this_response');
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,user_id,event_type,actor_kind,idempotency_key,
    request_digest,source_session_id,source_intake_receipt,safe_reason_code,user_catalog_generation,user_revocation_epoch)
  VALUES(event,'memop-'||replace(event::text,'-',''),p_user_id,'memory_source_action_accepted','user',p_idempotency_key,
    p_request_digest,p_session_id,receipt,'explicit_source_action_recorded',governance.user_catalog_generation,governance.user_revocation_epoch);
  RETURN receipt;
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_lookup_source_action(p_user_id text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; receipt jsonb;
BEGIN
  SELECT * INTO governance FROM public.sophia_memory_user_governance WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR governance.authority_state<>'governed' OR NOT EXISTS(SELECT 1 FROM public.sophia_memory_contract
    WHERE singleton AND schema_version='mem00.v1' AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced')) THEN
    RAISE EXCEPTION 'memory_source_authority_unavailable' USING ERRCODE='42501';
  END IF;
  SELECT source_intake_receipt INTO receipt FROM public.sophia_memory_governance_events
    WHERE user_id=p_user_id AND idempotency_key=p_idempotency_key AND event_type='memory_source_action_accepted';
  RETURN jsonb_build_object('schema','mem00.source-action-status.v1','owner_id',p_user_id,'command_key',p_idempotency_key,
    'status',CASE WHEN receipt IS NULL THEN 'not_found' ELSE 'committed' END,'historical_result_only',true,
    'receipt',CASE WHEN receipt IS NULL THEN NULL ELSE receipt||jsonb_build_object('idempotent_replay',true) END);
END $fn$;

REVOKE ALL ON FUNCTION public.sophia_memory_source_intake_version_trigger(),public.sophia_memory_source_intake_receipt_immutable(),
  public.sophia_memory_source_boundary(text,text,text),public.sophia_memory_lookup_source_action(text,text),
  public.sophia_memory_accept_source_action(text,text,text,text,uuid,text,bigint,text,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
