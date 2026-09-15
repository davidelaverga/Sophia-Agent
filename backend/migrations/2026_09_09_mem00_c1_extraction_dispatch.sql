-- Tenth C1 migration: STAGED, UNAPPROVED, private until batch qualification.
-- One-use authorization of an exact extractor request, not proof it was sent.
-- Existing governance events retain content-free attempt evidence. No provider.
BEGIN;
ALTER TABLE public.sophia_memory_governance_events
  ADD COLUMN IF NOT EXISTS extraction_dispatch_receipt jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS sophia_memory_dispatch_nonce
  ON public.sophia_memory_governance_events((extraction_dispatch_receipt->>'attempt_id'))
  WHERE extraction_dispatch_receipt IS NOT NULL;

CREATE OR REPLACE FUNCTION public.sophia_memory_dispatch_receipt_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF OLD.extraction_dispatch_receipt IS NOT NULL THEN
    RAISE EXCEPTION 'memory_extraction_dispatch_receipt_immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_dispatch_receipt_immutable ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_dispatch_receipt_immutable BEFORE UPDATE OR DELETE ON public.sophia_memory_governance_events
  FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_dispatch_receipt_immutable();

CREATE OR REPLACE FUNCTION public.sophia_memory_authorize_extraction_dispatch(
  p_user_id text,p_extraction_run_id uuid,p_lease_token uuid,p_attempt_id uuid,
  p_input_manifest_ref text,p_extractor_input_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE governance public.sophia_memory_user_governance; run public.sophia_memory_extraction_runs;
  event uuid:=gen_random_uuid(); receipt jsonb; accepted timestamptz; deadline timestamptz;
BEGIN
  IF p_extraction_run_id IS NULL OR p_lease_token IS NULL OR p_attempt_id IS NULL
    OR p_extractor_input_ref IS NULL OR p_extractor_input_ref !~ '^hmac-sha256:extractor-input:[a-f0-9]{64}$'
    OR p_input_manifest_ref IS NULL OR p_input_manifest_ref !~ '^hmac-sha256:transcript-manifest:[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'memory_extraction_dispatch_invalid' USING ERRCODE='22023';
  END IF;
  governance:=public.sophia_memory_ensure_governance(p_user_id);
  PERFORM 1 FROM public.sophia_memory_contract WHERE singleton AND schema_version='mem00.v1'
    AND contract_epoch=1 AND contract_epoch=governance.authority_epoch AND mode IN ('shadow','enforced') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_extraction_contract_unavailable' USING ERRCODE='40001'; END IF;
  -- An authorization receipt is never replayable permission. A lost response
  -- remains an unused/unknown dispatch; the next durable lease needs a new ID.
  IF EXISTS(SELECT 1 FROM public.sophia_memory_governance_events
    WHERE extraction_dispatch_receipt->>'attempt_id'=p_attempt_id::text) THEN
    RAISE EXCEPTION 'memory_extraction_dispatch_already_consumed' USING ERRCODE='40001';
  END IF;
  SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
    WHERE user_id=p_user_id AND extraction_run_id=p_extraction_run_id;
  PERFORM 1 FROM public.sophia_sessions WHERE user_id=p_user_id AND id=run.session_id
    AND thread_id=run.thread_id AND status='ended' AND NOT (coalesce(metadata,'{}'::jsonb)?'synthetic_voice_lab') FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'memory_extraction_source_unavailable' USING ERRCODE='40001'; END IF;
  SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
    WHERE user_id=p_user_id AND extraction_run_id=p_extraction_run_id FOR UPDATE;
  IF run.state<>'leased' OR run.lease_token IS DISTINCT FROM p_lease_token OR run.lease_expires_at IS NULL
    OR run.lease_expires_at<=clock_timestamp() OR run.memory_clear_epoch IS DISTINCT FROM governance.memory_clear_epoch
    OR run.input_manifest_ref IS DISTINCT FROM p_input_manifest_ref OR run.extractor_input_ref IS DISTINCT FROM p_extractor_input_ref
    OR run.extractor_contract_version<>'mem00.extract.v1'
    OR public.sophia_memory_run_source_valid(p_user_id,run.session_id,run.sequence_start,run.sequence_end,run.source_dependencies) IS NOT TRUE
    OR public.sophia_memory_run_input_valid(p_user_id,run.session_id,run.extractor_input_context,run.extractor_input_ref) IS NOT TRUE THEN
    RAISE EXCEPTION 'memory_extraction_dispatch_ineligible' USING ERRCODE='40001';
  END IF;
  IF public.sophia_memory_source_decision_overlaps(p_user_id,run.session_id,run.source_dependencies) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'memory_source_decision_mapping_unproven' USING ERRCODE='40001';
  END IF;
  accepted:=clock_timestamp();deadline:=least(run.lease_expires_at,accepted+interval '5 seconds');
  receipt:=jsonb_build_object('schema','mem00.extraction-dispatch.v1','owner_id',p_user_id,
    'session_id',run.session_id,'thread_id',run.thread_id,'extraction_run_id',p_extraction_run_id,
    'lease_token',p_lease_token,'attempt_id',p_attempt_id,'event_id',event,
    'input_manifest_ref',p_input_manifest_ref,'extractor_input_ref',p_extractor_input_ref,
    'memory_clear_epoch',governance.memory_clear_epoch,'accepted_at',accepted,'expires_at',deadline,
    'single_use',true,'sdk_max_retries',0,'dispatch_observed',false);
  INSERT INTO public.sophia_memory_governance_events(event_id,operation_id,idempotency_key,request_digest,user_id,
    event_type,actor_kind,safe_reason_code,user_catalog_generation,user_revocation_epoch,source_session_id,extraction_dispatch_receipt)
  VALUES(event,p_attempt_id::text,'extraction-dispatch:'||p_attempt_id::text,p_extractor_input_ref,p_user_id,
    'extraction_dispatch_authorized','worker','exact_source_dispatch_authorized',governance.user_catalog_generation,
    governance.user_revocation_epoch,run.session_id,receipt);
  RETURN receipt;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_dispatch_receipt_immutable(),
  public.sophia_memory_authorize_extraction_dispatch(text,uuid,uuid,uuid,text,text)
  FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
