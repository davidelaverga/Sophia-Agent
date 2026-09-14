-- Additive current-state inventory. No production approval/application implied.
-- One canonical store, one MVCC view, bounded pages; never a clear/admission receipt.
-- Requires dependency_authority.sql and review_snapshot.sql.
BEGIN;

CREATE OR REPLACE FUNCTION public.sophia_memory_inventory_snapshot(
  p_user_id text, p_view text DEFAULT 'all', p_snapshot_id text DEFAULT NULL,
  p_after_key text DEFAULT NULL, p_page_size integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $fn$
DECLARE result jsonb;
BEGIN
  IF p_user_id IS NULL OR p_user_id='' OR p_user_id<>btrim(p_user_id)
    OR p_view IS NULL OR p_view NOT IN ('all','saved','active','forgotten','pending_review')
    OR p_page_size IS NULL OR p_page_size NOT BETWEEN 1 AND 200
    OR (p_snapshot_id IS NOT NULL AND p_snapshot_id !~ '^[a-f0-9]{32}$')
    OR (p_after_key IS NOT NULL AND p_after_key !~ '^(candidate|memory):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    OR (p_after_key IS NOT NULL AND p_snapshot_id IS NULL) THEN
    RAISE EXCEPTION 'memory_inventory_request_invalid' USING ERRCODE='22023';
  END IF;
  WITH owner AS (
    SELECT g.* FROM public.sophia_memory_user_governance g
    JOIN public.sophia_memory_contract k ON k.singleton AND k.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed' AND g.authority_epoch=1
      AND k.schema_version='mem00.v1' AND k.mode IN ('shadow','enforced')
  ), sources AS MATERIALIZED (
    SELECT s.*,coalesce((SELECT jsonb_agg(jsonb_build_object('message_id',m.message_id,'sequence',m.sequence,
      'source_version',m.memory_source_version) ORDER BY m.sequence,m.message_id)
      FROM public.sophia_session_messages m WHERE m.user_id=s.user_id AND m.session_id=s.id
        AND m.final AND m.role IN ('user','assistant') AND btrim(m.content)<>''),'[]'::jsonb) AS dependencies
    FROM public.sophia_sessions s JOIN owner o ON o.user_id=s.user_id
    WHERE EXISTS(SELECT 1 FROM public.sophia_memory_extraction_runs r JOIN public.sophia_memory_candidates c
      ON c.user_id=r.user_id AND c.extraction_run_id=r.extraction_run_id WHERE r.user_id=s.user_id AND r.session_id=s.id)
  ), source_views AS MATERIALIZED (
    SELECT s.id,CASE WHEN e.source_target_receipt IS NOT NULL THEN
      public.sophia_memory_review_snapshot(s.user_id,s.id,s.message_revision,e.source_target_receipt->>'source_manifest_ref',
        s.dependencies,NULL,NULL,1)->>'extraction_state' ELSE 'unavailable' END AS state
    FROM sources s LEFT JOIN LATERAL (
      SELECT e.source_target_receipt FROM public.sophia_memory_governance_events e
      WHERE e.user_id=s.user_id AND e.source_session_id=s.id AND e.event_type='source_target_aligned'
        AND e.source_target_receipt->'source_target'->'source_dependencies'=s.dependencies
        AND e.source_target_receipt->'source_target'->>'owner_id'=s.user_id
        AND e.source_target_receipt->'source_target'->>'session_id'=s.id
        AND e.source_target_receipt->'source_target'->>'transcript_revision'=s.message_revision::text
      ORDER BY e.created_at DESC,e.event_id DESC LIMIT 1
    ) e ON true
  ), candidates AS (
    SELECT c.*,r.session_id,r.input_manifest_ref,r.sequence_start,r.sequence_end,
      v.proposed_content,v.content_ref,v.category,
      c.review_state='pending_review' AND c.created_at>now()-interval '30 days'
      AND sv.state IN ('complete','processing','failed_retryable','failed_terminal')
      AND v.scrubbed_at IS NULL AND v.proposed_content IS NOT NULL AND v.content_ref IS NOT NULL
      AND r.terminal_candidate_count IS NOT NULL AND r.state<>'superseded'
      AND public.sophia_memory_run_source_valid(r.user_id,r.session_id,r.sequence_start,r.sequence_end,r.source_dependencies)
      AND public.sophia_memory_run_input_valid(r.user_id,r.session_id,r.extractor_input_context,r.extractor_input_ref)
      AND EXISTS(SELECT 1 FROM public.sophia_memory_candidate_sources cs WHERE cs.user_id=c.user_id AND cs.candidate_id=c.candidate_id)
      AND NOT EXISTS(SELECT 1 FROM public.sophia_memory_candidate_sources cs
        WHERE cs.user_id=c.user_id AND cs.candidate_id=c.candidate_id AND
          (cs.invalidated_at IS NOT NULL OR cs.detached_at IS NOT NULL OR cs.session_id<>r.session_id
            OR cs.transcript_revision<>r.transcript_revision OR NOT EXISTS(
              SELECT 1 FROM public.sophia_session_messages m WHERE m.user_id=c.user_id AND m.session_id=r.session_id
                AND m.message_id=cs.message_id AND m.sequence=cs.sequence AND m.final
                AND m.role IN ('user','assistant') AND btrim(m.content)<>''))) AS reviewable
    FROM public.sophia_memory_candidates c JOIN owner o ON o.user_id=c.user_id
    JOIN public.sophia_memory_extraction_runs r ON r.user_id=c.user_id AND r.extraction_run_id=c.extraction_run_id
    LEFT JOIN source_views sv ON sv.id=r.session_id
    LEFT JOIN public.sophia_memory_candidate_versions v ON v.user_id=c.user_id AND v.candidate_id=c.candidate_id
      AND v.candidate_revision=c.current_candidate_revision
  ), saved AS (
    SELECT m.*,v.canonical_content,v.content_ref,v.category,v.scope,
      m.lifecycle IN ('active','forgotten') AND NOT EXISTS(SELECT 1 FROM public.sophia_memory_tombstones t
        WHERE t.user_id=m.user_id AND t.memory_id=m.memory_id) AS readable,
      v.memory_version_id IS NOT NULL AND v.scrubbed_at IS NULL
        AND v.canonical_content IS NOT NULL AND v.content_ref IS NOT NULL AS version_present
    FROM public.sophia_memories m JOIN owner o ON o.user_id=m.user_id
    LEFT JOIN public.sophia_memory_versions v ON v.user_id=m.user_id AND v.memory_id=m.memory_id
      AND v.content_revision=m.current_content_revision
  ), records AS (
    SELECT 'candidate:'||c.candidate_id::text AS key,
      jsonb_build_object('kind','candidate','id',c.candidate_id,'revision',c.current_candidate_revision,
        'state',c.review_state,'reviewable',coalesce(c.reviewable,false),'session_id',c.session_id,
        'extraction_run_id',c.extraction_run_id,'source_manifest_ref',c.input_manifest_ref,
        'content',CASE WHEN c.reviewable THEN c.proposed_content END,
        'category',CASE WHEN c.reviewable THEN c.category END,
        'memory_governance_revision',NULL,'user_tier',NULL,'scope',NULL,
        'created_at',c.created_at,'updated_at',NULL,
        'content_disposition',CASE WHEN c.reviewable THEN 'current_review_text' ELSE 'withheld_not_reviewable' END) AS item,
      c.content_ref AS fingerprint_ref,
      p_view='all' OR (p_view='pending_review' AND c.reviewable) AS selected,
      false AS invalid
    FROM candidates c
    UNION ALL
    SELECT 'memory:'||m.memory_id::text,
      jsonb_build_object('kind','memory','id',m.memory_id,'revision',m.current_content_revision,
        'state',m.lifecycle,'reviewable',false,'session_id',NULL,'extraction_run_id',NULL,'source_manifest_ref',NULL,
        'content',CASE WHEN m.readable AND m.version_present THEN m.canonical_content END,
        'category',CASE WHEN m.readable AND m.version_present THEN m.category END,
        'memory_governance_revision',m.memory_governance_revision,'user_tier',m.user_tier,
        'scope',CASE WHEN m.readable AND m.version_present THEN m.scope END,
        'created_at',m.created_at,'updated_at',m.updated_at,
        'content_disposition',CASE WHEN m.readable AND m.version_present THEN 'current_canonical_text' ELSE 'withheld_tombstoned' END),
      m.content_ref, p_view='all' OR (p_view='saved' AND m.readable) OR (p_view=m.lifecycle AND m.readable),
      (m.readable AND NOT m.version_present) OR (m.lifecycle IN ('active','forgotten') AND NOT m.readable)
    FROM saved m
  ), summary AS (
    SELECT jsonb_build_object('canonical_records',(SELECT count(*) FROM saved),
      'candidate_records',(SELECT count(*) FROM candidates),
      'reviewable_pending',(SELECT count(*) FROM candidates WHERE reviewable),
      'withheld_candidates',(SELECT count(*) FROM candidates WHERE NOT coalesce(reviewable,false)),
      'unavailable_review_sources',(SELECT count(*) FROM source_views WHERE state NOT IN ('complete','processing','failed_retryable','failed_terminal')),
      'unfinished_extraction_runs',(SELECT count(*) FROM public.sophia_memory_extraction_runs r JOIN owner o ON o.user_id=r.user_id
        WHERE r.state IN ('queued','leased','retry_wait','failed_terminal'))) AS value
  ), snapshot AS (
    SELECT md5(jsonb_build_object('owner',p_user_id,'view',p_view,'summary',(SELECT value FROM summary),
      'clocks',(SELECT jsonb_build_array(user_catalog_generation,user_revocation_epoch,last_event_id) FROM owner),
      'rows',coalesce(jsonb_agg(jsonb_build_array(key,item-'content',fingerprint_ref,selected,invalid) ORDER BY key),'[]'::jsonb))::text) AS id
    FROM records
  ), status AS (
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM owner) OR EXISTS(SELECT 1 FROM records WHERE invalid) THEN 'unavailable'
      WHEN p_snapshot_id IS NOT NULL AND p_snapshot_id<>(SELECT id FROM snapshot) THEN 'snapshot_changed'
      ELSE 'available' END AS value
  ), page AS (
    SELECT * FROM records WHERE selected AND (p_after_key IS NULL OR key>p_after_key)
      ORDER BY key LIMIT p_page_size+1
  ), visible AS (SELECT * FROM page ORDER BY key LIMIT p_page_size)
  SELECT jsonb_build_object('schema','mem00.inventory.v1','memory_contract_epoch',1,'owner_id',p_user_id,
    'scope','current_saved_and_candidate_state','view',p_view,'status',(SELECT value FROM status),
    'snapshot_id',(SELECT id FROM snapshot),'after_key',p_after_key,
    'summary',CASE WHEN (SELECT value FROM status)='available' THEN (SELECT value FROM summary) END,
    'total_count',CASE WHEN (SELECT value FROM status)='available' THEN (SELECT count(*) FROM records WHERE selected) END,
    'records',CASE WHEN (SELECT value FROM status)='available' THEN coalesce((SELECT jsonb_agg(item ORDER BY key) FROM visible),'[]'::jsonb) ELSE '[]'::jsonb END,
    'next_after_key',CASE WHEN (SELECT value FROM status)='available' AND (SELECT count(*) FROM page)>p_page_size THEN (SELECT max(key) FROM visible) END,
    'enumeration_complete',(SELECT value FROM status)='available' AND (SELECT count(*) FROM page)<=p_page_size,
    'historical_versions_included',false,'source_transcripts_included',false,'provider_state_queried',false,
    'extraction_complete',false) INTO result;
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_inventory_snapshot(text,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_inventory_snapshot(text,text,text,text,integer) TO service_role;

-- Exact preparatory hit resolution, never a Pool scan or final prompt permit.
CREATE OR REPLACE FUNCTION public.sophia_memory_resolve_provider_hits(
  p_user_id text, p_provider text, p_environment text, p_provider_project text,
  p_provider_namespace text, p_provider_memory_ids jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE result jsonb;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id)='' OR p_user_id<>btrim(p_user_id)
    OR p_provider IS NULL OR btrim(p_provider)='' OR p_environment IS NULL OR btrim(p_environment)=''
    OR p_provider_project IS NULL OR btrim(p_provider_project)='' OR p_provider_namespace IS NULL OR btrim(p_provider_namespace)=''
    OR p_provider_memory_ids IS NULL OR jsonb_typeof(p_provider_memory_ids)<>'array' THEN
    RAISE EXCEPTION 'memory_hit_selector_invalid' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_provider_memory_ids)>100
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_provider_memory_ids) x
      WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}') NOT BETWEEN 1 AND 512 OR x#>>'{}'<>btrim(x#>>'{}'))
    OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(p_provider_memory_ids)x) THEN
    RAISE EXCEPTION 'memory_hit_selector_invalid' USING ERRCODE='22023';
  END IF;
  WITH owner AS (
    SELECT g.* FROM public.sophia_memory_user_governance g JOIN public.sophia_memory_contract k
      ON k.singleton AND k.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed' AND g.authority_epoch=1
      AND k.schema_version='mem00.v1' AND k.mode IN ('shadow','enforced') AND g.provider_subject=p_provider_namespace
  ), requested AS (
    SELECT value AS id,ordinality AS n FROM jsonb_array_elements_text(p_provider_memory_ids) WITH ORDINALITY
  ), matches AS (
    SELECT r.id,r.n,b.*,count(b.provider_binding_id) OVER(PARTITION BY r.id) AS match_count
    FROM requested r LEFT JOIN public.sophia_memory_provider_bindings b ON b.user_id=p_user_id
      AND b.provider=p_provider AND b.environment=p_environment AND b.provider_project=p_provider_project
      AND b.provider_namespace=p_provider_namespace AND b.provider_memory_id=r.id
  ), resolved AS (
    SELECT DISTINCT ON (b.id) b.id,b.n,
      CASE WHEN b.match_count=0 THEN 'unmapped_provider_id'
        WHEN b.match_count<>1 OR b.binding_state<>'eligible' OR b.metadata_verification_state<>'verified'
          OR m.memory_id IS NULL OR m.lifecycle<>'active'
          OR EXISTS(SELECT 1 FROM public.sophia_memory_tombstones t WHERE t.user_id=p_user_id AND t.memory_id=m.memory_id)
          THEN 'inactive_projection'
        WHEN m.current_content_revision<>b.canonical_content_revision THEN 'stale_content_revision'
        WHEN m.memory_governance_revision<>b.memory_governance_revision THEN 'stale_memory_governance_revision'
        WHEN v.memory_version_id IS NULL OR v.scrubbed_at IS NOT NULL OR v.canonical_content IS NULL OR btrim(v.canonical_content)=''
          OR v.content_ref IS NULL OR v.category IS NULL OR v.scope IS NULL THEN 'unknown_status'
        ELSE NULL END AS denial,
      jsonb_build_object('memory_id',m.memory_id,'user_id',m.user_id,'lifecycle',m.lifecycle,'user_tier',m.user_tier,
        'current_content_revision',m.current_content_revision,'memory_governance_revision',m.memory_governance_revision,
        'canonical_content',v.canonical_content,'content_ref',v.content_ref,'category',v.category,'scope',v.scope,
        'projection_state','active','created_at',m.created_at,'updated_at',m.updated_at) AS memory
    FROM matches b LEFT JOIN public.sophia_memories m ON m.user_id=p_user_id AND m.memory_id=b.memory_id
    LEFT JOIN public.sophia_memory_versions v ON v.user_id=m.user_id AND v.memory_id=m.memory_id
      AND v.content_revision=m.current_content_revision ORDER BY b.id,b.provider_binding_id
  )
  SELECT jsonb_build_object('schema','mem00.hit-resolution.v1','memory_contract_epoch',1,'owner_id',p_user_id,
    'provider',p_provider,'environment',p_environment,'provider_project',p_provider_project,'provider_namespace',p_provider_namespace,
    'status',CASE WHEN EXISTS(SELECT 1 FROM owner) THEN 'available' ELSE 'unavailable' END,
    'final_admission',false,'results',CASE WHEN EXISTS(SELECT 1 FROM owner) THEN coalesce(
      (SELECT jsonb_agg(jsonb_build_object('provider_memory_id',id,'denial_reason',denial,
        'memory',CASE WHEN denial IS NULL THEN memory END) ORDER BY n) FROM resolved),'[]'::jsonb) ELSE '[]'::jsonb END) INTO result;
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_resolve_provider_hits(text,text,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_resolve_provider_hits(text,text,text,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.sophia_memory_current_view(p_user_id text,p_memory_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
DECLARE result jsonb;
BEGIN
  IF p_user_id IS NULL OR btrim(p_user_id)='' OR p_user_id<>btrim(p_user_id) OR p_memory_id IS NULL THEN
    RAISE EXCEPTION 'memory_current_selector_invalid' USING ERRCODE='22023';
  END IF;
  WITH owner AS (
    SELECT g.user_id FROM public.sophia_memory_user_governance g JOIN public.sophia_memory_contract k
      ON k.singleton AND k.contract_epoch=g.authority_epoch
    WHERE g.user_id=p_user_id AND g.authority_state='governed' AND g.authority_epoch=1
      AND k.schema_version='mem00.v1' AND k.mode IN ('shadow','enforced')
  ), selected AS (
    SELECT m.*,v.canonical_content,v.content_ref,v.category,v.scope,
      m.lifecycle IN ('active','forgotten') AND v.memory_version_id IS NOT NULL AND v.scrubbed_at IS NULL
      AND v.canonical_content IS NOT NULL AND btrim(v.canonical_content)<>'' AND v.content_ref IS NOT NULL
      AND v.category IS NOT NULL AND v.scope IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.sophia_memory_tombstones t WHERE t.user_id=m.user_id AND t.memory_id=m.memory_id) AS readable
    FROM public.sophia_memories m JOIN owner o ON o.user_id=m.user_id
    LEFT JOIN public.sophia_memory_versions v ON v.user_id=m.user_id AND v.memory_id=m.memory_id AND v.content_revision=m.current_content_revision
    WHERE m.memory_id=p_memory_id
  ), state AS (
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM owner) THEN 'unavailable'
      WHEN NOT EXISTS(SELECT 1 FROM selected) THEN 'not_found'
      WHEN EXISTS(SELECT 1 FROM selected WHERE lifecycle='tombstoned' OR readable) THEN 'available'
      ELSE 'unavailable' END AS status
  )
  SELECT jsonb_build_object('schema','mem00.current-memory.v1','owner_id',p_user_id,'memory_id',p_memory_id,
    'status',state.status,'lifecycle',CASE WHEN state.status='available' THEN m.lifecycle END,
    'content_revision',CASE WHEN state.status='available' THEN m.current_content_revision END,
    'memory_governance_revision',CASE WHEN state.status='available' THEN m.memory_governance_revision END,
    'memory',CASE WHEN state.status='available' AND m.readable THEN jsonb_build_object(
      'kind','memory','id',m.memory_id,'revision',m.current_content_revision,'state',m.lifecycle,'reviewable',false,
      'session_id',NULL,'extraction_run_id',NULL,'source_manifest_ref',NULL,'content',m.canonical_content,'category',m.category,
      'memory_governance_revision',m.memory_governance_revision,'user_tier',m.user_tier,'scope',m.scope,
      'created_at',m.created_at,'updated_at',m.updated_at,'content_disposition','current_canonical_text') END,
    'provider_state_queried',false,'current_view_only',true) INTO result FROM state LEFT JOIN selected m ON true;
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.sophia_memory_current_view(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_current_view(text,uuid) TO service_role;
COMMIT;
