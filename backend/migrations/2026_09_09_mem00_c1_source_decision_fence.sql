-- STAGED CONTAINMENT ONLY. Seventh C1 migration; production approval required.
-- Current extractor witnesses describe full input, not per-fact attribution.
-- Ambiguous overlapping decisions deny publication; they are never successful
-- zero, fuzzy text suppression, or proof of exact candidate-mapping closure.
BEGIN;
ALTER TABLE public.sophia_memory_governance_events
  ADD COLUMN IF NOT EXISTS source_decision_witnesses jsonb;
CREATE INDEX IF NOT EXISTS sophia_memory_source_decision_owner
  ON public.sophia_memory_governance_events(user_id)
  WHERE event_type IN ('candidate_rejected','memory_tombstoned');

CREATE OR REPLACE FUNCTION public.sophia_memory_capture_source_decision(
  p_owner text,p_event_type text,p_candidate uuid,p_memory uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE source_candidate uuid; run public.sophia_memory_extraction_runs; dependencies jsonb:='null'::jsonb; dependency jsonb; valid boolean:=true;
BEGIN
  IF p_event_type='candidate_rejected' THEN source_candidate:=p_candidate;
  ELSIF p_event_type='memory_tombstoned' THEN
    SELECT origin_candidate_id INTO source_candidate FROM public.sophia_memories
      WHERE user_id=p_owner AND memory_id=p_memory;
    -- Empty is proven absence of extraction lineage only for an original
    -- manual-create receipt, not a possibly detached historical candidate.
    IF source_candidate IS NULL AND EXISTS(SELECT 1 FROM public.sophia_memory_governance_events
      WHERE user_id=p_owner AND memory_id=p_memory AND event_type='memory_manual_created') THEN
      RETURN '[]'::jsonb;
    END IF;
  ELSE RETURN NULL;
  END IF;
  SELECT r.* INTO run FROM public.sophia_memory_candidates c
    JOIN public.sophia_memory_extraction_runs r ON r.user_id=c.user_id AND r.extraction_run_id=c.extraction_run_id
    WHERE c.user_id=p_owner AND c.candidate_id=source_candidate;
  -- JSON null is an immutable unknown witness, distinct from SQL NULL (not
  -- captured yet). Never upgrade old transcript-only proof into exact versions.
  IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  IF run.extractor_input_ref ~ '^hmac-sha256:extractor-input:[a-f0-9]{64}$'
    AND jsonb_typeof(run.source_dependencies)='array' AND jsonb_array_length(run.source_dependencies) BETWEEN 1 AND 10000 THEN
    FOR dependency IN SELECT value FROM jsonb_array_elements(run.source_dependencies) LOOP
      IF jsonb_typeof(dependency) IS DISTINCT FROM 'object' THEN valid:=false; EXIT; END IF;
      IF NOT coalesce((SELECT count(*) FROM jsonb_object_keys(dependency))=3
        AND jsonb_typeof(dependency->'message_id')='string' AND length(dependency->>'message_id')>0
        AND jsonb_typeof(dependency->'sequence')='number' AND dependency->>'sequence' ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(dependency->'source_version')='string'
        AND dependency->>'source_version' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',false) THEN
        valid:=false; EXIT;
      END IF;
    END LOOP;
    IF valid AND jsonb_array_length(run.source_dependencies)=(SELECT count(DISTINCT d->>'message_id') FROM jsonb_array_elements(run.source_dependencies) d) THEN
      dependencies:=run.source_dependencies;
    END IF;
  END IF;
  RETURN jsonb_build_array(jsonb_build_object('session_id',run.session_id,
    'extraction_run_id',run.extraction_run_id,'dependencies',dependencies));
END $fn$;

CREATE OR REPLACE FUNCTION public.sophia_memory_source_decision_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.event_type IN ('candidate_rejected','memory_tombstoned') THEN
      RAISE EXCEPTION 'memory_source_decision_immutable' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.event_type IN ('candidate_rejected','memory_tombstoned') THEN
    IF ROW(NEW.user_id,NEW.event_type,NEW.event_id) IS DISTINCT FROM ROW(OLD.user_id,OLD.event_type,OLD.event_id)
      OR (OLD.source_decision_witnesses IS NOT NULL AND NEW.source_decision_witnesses IS DISTINCT FROM OLD.source_decision_witnesses) THEN
      RAISE EXCEPTION 'memory_source_decision_immutable' USING ERRCODE='23514';
    END IF;
    IF OLD.source_decision_witnesses IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  IF NEW.event_type IN ('candidate_rejected','memory_tombstoned') THEN
    NEW.source_decision_witnesses:=public.sophia_memory_capture_source_decision(
      NEW.user_id,NEW.event_type,NEW.candidate_id,NEW.memory_id);
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS sophia_memory_source_decision ON public.sophia_memory_governance_events;
CREATE TRIGGER sophia_memory_source_decision BEFORE INSERT OR UPDATE OR DELETE
  ON public.sophia_memory_governance_events FOR EACH ROW EXECUTE FUNCTION public.sophia_memory_source_decision_trigger();
-- Content-free reconstruction only from already retained immutable lineage.
-- Unknown history stays explicit unknown and fails closed, not silently ignored.
UPDATE public.sophia_memory_governance_events SET source_decision_witnesses=NULL
  WHERE event_type IN ('candidate_rejected','memory_tombstoned') AND source_decision_witnesses IS NULL;

CREATE OR REPLACE FUNCTION public.sophia_memory_source_decision_overlaps(
  p_owner text,p_session text,p_dependencies jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE event record; witness jsonb;
BEGIN
  IF jsonb_typeof(p_dependencies) IS DISTINCT FROM 'array' OR jsonb_array_length(p_dependencies)=0 THEN RETURN true; END IF;
  FOR event IN SELECT source_decision_witnesses FROM public.sophia_memory_governance_events
    WHERE user_id=p_owner AND event_type IN ('candidate_rejected','memory_tombstoned') LOOP
    IF jsonb_typeof(event.source_decision_witnesses) IS DISTINCT FROM 'array' THEN RETURN true; END IF;
    FOR witness IN SELECT value FROM jsonb_array_elements(event.source_decision_witnesses) LOOP
      IF witness->>'session_id' IS NULL THEN RETURN true; END IF;
      IF witness->>'session_id'<>p_session THEN CONTINUE; END IF;
      IF jsonb_typeof(witness->'dependencies') IS DISTINCT FROM 'array' THEN RETURN true; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(witness->'dependencies') old_source
        JOIN jsonb_array_elements(p_dependencies) new_source ON
          old_source->>'message_id'=new_source->>'message_id'
          AND old_source->>'sequence'=new_source->>'sequence'
          AND old_source->>'source_version'=new_source->>'source_version') THEN RETURN true; END IF;
    END LOOP;
  END LOOP;
  RETURN false;
END $fn$;

DO $migration$
BEGIN
  IF to_regprocedure('public.sophia_memory_complete_extraction_pre_decision_fence(text,uuid,uuid,text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb)
      RENAME TO sophia_memory_complete_extraction_pre_decision_fence;
  END IF;
END $migration$;
CREATE OR REPLACE FUNCTION public.sophia_memory_complete_extraction(
  p_user_id text,p_extraction_run_id uuid,p_lease_token uuid,p_input_manifest_ref text,p_candidates jsonb
) RETURNS public.sophia_memory_extraction_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE run public.sophia_memory_extraction_runs;
BEGIN
  -- Same owner serialization as reject/tombstone, then parent and run. The
  -- whole decision/guard is in one canonical transaction; no provider access.
  PERFORM public.sophia_memory_ensure_governance(p_user_id);
  SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs WHERE user_id=p_user_id AND extraction_run_id=p_extraction_run_id;
  IF run.state IN ('succeeded_zero','succeeded_nonzero') THEN
    IF run.input_manifest_ref IS DISTINCT FROM p_input_manifest_ref THEN
      RAISE EXCEPTION 'memory_extraction_input_conflict' USING ERRCODE='40001';
    END IF;
    RETURN run; -- Historical batch receipt only; no new proposal or decision.
  END IF;
  PERFORM 1 FROM public.sophia_sessions WHERE user_id=p_user_id AND id=run.session_id FOR UPDATE;
  IF public.sophia_memory_source_decision_overlaps(p_user_id,run.session_id,run.source_dependencies) THEN
    RAISE EXCEPTION 'memory_source_decision_mapping_unproven' USING ERRCODE='40001';
  END IF;
  RETURN public.sophia_memory_complete_extraction_pre_decision_fence(
    p_user_id,p_extraction_run_id,p_lease_token,p_input_manifest_ref,p_candidates);
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_capture_source_decision(text,text,uuid,uuid),
  public.sophia_memory_source_decision_trigger(),
  public.sophia_memory_source_decision_overlaps(text,text,jsonb),
  public.sophia_memory_complete_extraction_pre_decision_fence(text,uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_complete_extraction(text,uuid,uuid,text,jsonb) TO service_role;
COMMIT;
