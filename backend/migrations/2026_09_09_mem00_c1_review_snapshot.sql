-- Additive read-only canonical review snapshot. Staged; production approval required.
-- A STABLE SQL function evaluates all joins/counts/pages against one MVCC view.
-- Source message selection is supplied only by the authenticated server reader,
-- bound to the exact current parent revision and checked against canonical rows.
-- Requires 2026_09_09_mem00_c1_dependency_authority.sql.
BEGIN;
CREATE OR REPLACE FUNCTION public.sophia_memory_review_snapshot(
    p_user_id text, p_session_id text, p_transcript_revision bigint,
    p_source_manifest_ref text, p_target_messages jsonb,
    p_snapshot_id text DEFAULT NULL, p_after_candidate_id uuid DEFAULT NULL,
    p_page_size integer DEFAULT 100
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $function$
WITH owner AS (
    SELECT g.*, k.contract_epoch FROM public.sophia_memory_user_governance g
    JOIN public.sophia_memory_contract k ON k.singleton AND k.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed'
      AND k.schema_version='mem00.v1' AND k.mode IN ('shadow','enforced')
), source AS (
    SELECT s.id,s.user_id,s.thread_id,s.message_revision,s.status,s.ended_at
    FROM public.sophia_sessions s JOIN owner o ON o.user_id=s.user_id
    WHERE s.id=p_session_id
), target AS (
    SELECT x.message_id,x.sequence,x.source_version FROM jsonb_to_recordset(p_target_messages) AS x(message_id text,sequence bigint,source_version uuid)
), finalization_receipt AS (
    SELECT e.event_id,e.source_target_receipt->'source_target' AS target
    FROM public.sophia_memory_governance_events e JOIN source s ON e.user_id=s.user_id AND e.source_session_id=s.id
    WHERE e.event_type='source_target_aligned' AND e.source_target_receipt->>'source_manifest_ref'=p_source_manifest_ref
      AND e.source_target_receipt->'source_target'->>'owner_id'=s.user_id
      AND e.source_target_receipt->'source_target'->>'session_id'=s.id
      AND e.source_target_receipt->'source_target'->>'thread_id'=s.thread_id
      AND e.source_target_receipt->'source_target'->>'transcript_revision'=s.message_revision::text
      AND e.source_target_receipt->'source_target'->>'source_manifest_ref'=p_source_manifest_ref
      AND e.source_target_receipt->'source_target'->>'status'='ended'
      AND (e.source_target_receipt->'source_target'->>'ended_at')::timestamptz=s.ended_at
      AND e.source_target_receipt->'source_target'->>'message_count'=(SELECT count(*)::text FROM target)
      AND (e.source_target_receipt->'source_target'->>'sequence_start')::bigint IS NOT DISTINCT FROM (SELECT min(sequence) FROM target)
      AND (e.source_target_receipt->'source_target'->>'sequence_end')::bigint IS NOT DISTINCT FROM (SELECT max(sequence) FROM target)
    ORDER BY e.created_at DESC,e.event_id DESC LIMIT 1
), runs AS (
    SELECT r.*,r.state<>'superseded' AND public.sophia_memory_run_source_valid(
      r.user_id,r.session_id,r.sequence_start,r.sequence_end,r.source_dependencies)
      AND public.sophia_memory_run_input_valid(r.user_id,r.session_id,r.extractor_input_context,r.extractor_input_ref) AS dependencies_valid
    FROM public.sophia_memory_extraction_runs r JOIN source s
    ON r.user_id=s.user_id AND r.session_id=s.id
), batch AS (
    SELECT c.*,v.proposed_content,v.content_ref,v.category,v.scrubbed_at AS version_scrubbed_at,
        r.sequence_start,r.sequence_end,r.input_manifest_ref,r.transcript_revision,
        r.dependencies_valid AND EXISTS (SELECT 1 FROM public.sophia_memory_candidate_sources cs WHERE cs.user_id=c.user_id AND cs.candidate_id=c.candidate_id)
        AND NOT EXISTS (SELECT 1 FROM public.sophia_memory_candidate_sources cs
            WHERE cs.user_id=c.user_id AND cs.candidate_id=c.candidate_id
              AND (cs.invalidated_at IS NOT NULL OR cs.detached_at IS NOT NULL OR cs.session_id<>r.session_id
                OR cs.transcript_revision<>r.transcript_revision
                OR NOT EXISTS(SELECT 1 FROM target t WHERE t.message_id=cs.message_id AND t.sequence=cs.sequence))) AS sources_valid
    FROM public.sophia_memory_candidates c JOIN runs r
      ON r.user_id=c.user_id AND r.extraction_run_id=c.extraction_run_id
    LEFT JOIN public.sophia_memory_candidate_versions v
      ON v.user_id=c.user_id AND v.candidate_id=c.candidate_id AND v.candidate_revision=c.current_candidate_revision
    WHERE r.terminal_candidate_count IS NOT NULL
), visible AS (
    SELECT * FROM batch WHERE review_state='pending_review' AND sources_valid
      AND version_scrubbed_at IS NULL AND proposed_content IS NOT NULL AND content_ref IS NOT NULL
      AND created_at > now()-interval '30 days'
), facts AS (
    SELECT
      (SELECT count(*) FROM target) AS target_count,
      (SELECT count(DISTINCT m.message_id) FROM public.sophia_session_messages m
        JOIN source s ON s.id=m.session_id AND s.user_id=m.user_id
        WHERE m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>'') AS source_message_count,
      (SELECT count(*) FROM target t WHERE EXISTS (
        SELECT 1 FROM public.sophia_session_messages m JOIN source s ON s.id=m.session_id AND s.user_id=m.user_id
        WHERE m.message_id=t.message_id AND m.sequence=t.sequence AND m.memory_source_version=t.source_version AND m.final
          AND m.role IN ('user','assistant') AND btrim(m.content)<>'')) AS matched_count,
      (SELECT count(*) FROM target t WHERE EXISTS (SELECT 1 FROM runs r
        WHERE r.dependencies_valid AND r.state IN ('succeeded_zero','succeeded_nonzero') AND t.sequence BETWEEN r.sequence_start AND r.sequence_end)) AS covered_count,
      (SELECT count(*) FROM runs) AS run_count,
      (SELECT count(*) FROM runs WHERE dependencies_valid AND state='retry_wait') AS retry_count,
      (SELECT count(*) FROM runs WHERE dependencies_valid AND state='failed_terminal') AS failed_count,
      (SELECT count(*) FROM runs WHERE dependencies_valid AND state IN ('queued','leased')) AS processing_count,
      (SELECT coalesce(sum(terminal_candidate_count),0) FROM runs) AS produced_count,
      (SELECT count(*) FROM batch) AS stored_count,
      (SELECT count(*) FROM visible) AS pending_count,
      (SELECT count(*) FROM batch WHERE review_state='approved') AS approved_count,
      (SELECT count(*) FROM batch WHERE review_state='rejected') AS rejected_count,
      (SELECT count(*) FROM batch WHERE review_state IN ('expired','legacy_quarantined')
        OR (review_state='pending_review' AND (NOT sources_valid OR created_at<=now()-interval '30 days'))) AS invalidated_count
), revision AS (
    SELECT md5(jsonb_build_array(p_user_id,p_session_id,p_transcript_revision,p_source_manifest_ref,p_target_messages,
      (SELECT row_to_json(s) FROM source s),(SELECT last_event_id FROM owner),
      (SELECT event_id FROM finalization_receipt),
      public.sophia_memory_source_fenced(p_user_id,p_session_id),
      (SELECT jsonb_agg(jsonb_build_array(extraction_run_id,state,terminal_candidate_count,dependencies_valid,updated_at) ORDER BY extraction_run_id) FROM runs),
      (SELECT jsonb_agg(jsonb_build_array(candidate_id,current_candidate_revision,review_state,version_scrubbed_at,sources_valid,content_ref,
        created_at>now()-interval '30 days') ORDER BY candidate_id) FROM batch)
    )::text) AS snapshot_id
), state AS (
    SELECT CASE
      WHEN NOT EXISTS(SELECT 1 FROM owner) THEN 'unavailable'
      WHEN NOT EXISTS(SELECT 1 FROM source) THEN 'not_found'
      WHEN public.sophia_memory_source_fenced(p_user_id,p_session_id) THEN 'unavailable'
      WHEN (SELECT message_revision FROM source)<>p_transcript_revision OR matched_count<>target_count OR source_message_count<>target_count
        OR target_count<>(SELECT count(DISTINCT message_id) FROM target)
        OR target_count<>(SELECT count(DISTINCT sequence) FROM target) THEN 'source_changed'
      WHEN p_snapshot_id IS NOT NULL AND p_snapshot_id<>(SELECT snapshot_id FROM revision) THEN 'snapshot_changed'
      WHEN p_page_size<1 OR p_page_size>200 OR (p_after_candidate_id IS NOT NULL AND p_snapshot_id IS NULL) THEN 'unavailable'
      WHEN (SELECT status FROM source)<>'ended' OR (SELECT ended_at FROM source) IS NULL OR NOT EXISTS(SELECT 1 FROM finalization_receipt) THEN 'awaiting_finalization'
      WHEN produced_count<>stored_count THEN 'unavailable'
      WHEN EXISTS(SELECT 1 FROM batch WHERE review_state='pending_review' AND sources_valid
        AND created_at>now()-interval '30 days' AND (proposed_content IS NULL OR content_ref IS NULL OR version_scrubbed_at IS NOT NULL)) THEN 'unavailable'
      WHEN failed_count>0 THEN 'failed_terminal'
      WHEN retry_count>0 THEN 'failed_retryable'
      WHEN processing_count>0 OR covered_count<>target_count THEN 'processing'
      ELSE 'complete' END AS extraction_state, f.*
    FROM facts f
), page_plus AS (
    SELECT * FROM visible WHERE (p_after_candidate_id IS NULL OR candidate_id>p_after_candidate_id)
    ORDER BY candidate_id LIMIT greatest(1,least(p_page_size,200))+1
), page AS (
    SELECT * FROM page_plus ORDER BY candidate_id LIMIT greatest(1,least(p_page_size,200))
)
SELECT jsonb_build_object(
  'schema','mem00.review.v1','memory_contract_epoch',(SELECT contract_epoch FROM owner),'owner_id',p_user_id,
  'session_id',p_session_id,'thread_id',(SELECT thread_id FROM source),
  'transcript_revision',p_transcript_revision,'source_manifest_ref',p_source_manifest_ref,
  'target_sequence_start',(SELECT min(sequence) FROM target),'target_sequence_end',(SELECT max(sequence) FROM target),
  'finalization',jsonb_build_object('kind','source_target_receipt','status',(SELECT status FROM source),'ended_at',(SELECT ended_at FROM source),
    'event_id',(SELECT event_id FROM finalization_receipt),
    'transcript_revision',(SELECT (target->>'transcript_revision')::bigint FROM finalization_receipt),
    'source_manifest_ref',(SELECT target->>'source_manifest_ref' FROM finalization_receipt)),
  'snapshot_id',(SELECT snapshot_id FROM revision),'review_filter','pending_review',
  'extraction_state',extraction_state,'target_message_count',target_count,'covered_message_count',covered_count,'run_count',run_count,
  'summary',jsonb_build_object('scope','session_history','produced',produced_count,'pending',pending_count,
    'approved',approved_count,'rejected',rejected_count,'invalidated',invalidated_count),
  'candidates',CASE WHEN extraction_state IN ('complete','processing','failed_retryable','failed_terminal') THEN
    coalesce((SELECT jsonb_agg(jsonb_build_object('candidate_id',candidate_id,'candidate_revision',current_candidate_revision,
      'review_state',review_state,'content',proposed_content,'category',category,'extraction_run_id',extraction_run_id,
      'source_manifest_ref',input_manifest_ref,'sequence_start',sequence_start,'sequence_end',sequence_end)
      ORDER BY candidate_id) FROM page),'[]'::jsonb) ELSE '[]'::jsonb END,
  'next_after_candidate_id',CASE WHEN (SELECT count(*) FROM page_plus)>p_page_size THEN (SELECT max(candidate_id::text) FROM page) ELSE NULL END,
  'enumeration_complete',(SELECT count(*) FROM page_plus)<=p_page_size,
  'retryable',extraction_state IN ('processing','failed_retryable','source_changed','snapshot_changed','unavailable'),
  'recovery_action',CASE WHEN extraction_state IN ('source_changed','snapshot_changed') THEN 'refresh_view'
     WHEN extraction_state='processing' THEN 'await_or_recover_extraction'
     WHEN extraction_state='failed_retryable' THEN 'retry_extraction'
     WHEN extraction_state='awaiting_finalization' THEN 'finalize_source'
     WHEN extraction_state IN ('unavailable','failed_terminal') THEN 'inspect_failure' ELSE 'none' END
) FROM state;
$function$;
REVOKE ALL ON FUNCTION public.sophia_memory_review_snapshot(text,text,bigint,text,jsonb,text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_review_snapshot(text,text,bigint,text,jsonb,text,uuid,integer) TO service_role;
COMMIT;
