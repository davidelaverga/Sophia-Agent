-- MEM00 durable memory governance and approved-only Mem0 projection.
--
-- Additive only. Applying this migration does not activate any memory path:
-- the singleton contract starts in `disabled` mode and every application
-- feature flag is default-closed. Browser roles receive no table privileges.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sophia_memory_contract (
    singleton                  BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
    contract_epoch             BIGINT NOT NULL CHECK (contract_epoch > 0),
    schema_version             TEXT NOT NULL,
    mode                       TEXT NOT NULL CHECK (mode IN ('disabled', 'shadow', 'enforced')),
    candidate_plaintext_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (candidate_plaintext_retention_days = 30),
    content_free_receipt_retention_days INTEGER NOT NULL DEFAULT 3650 CHECK (content_free_receipt_retention_days >= 365),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.sophia_memory_contract(singleton, contract_epoch, schema_version, mode)
VALUES (true, 1, 'mem00.v1', 'disabled')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.sophia_memory_user_governance (
    user_id                    TEXT PRIMARY KEY,
    user_catalog_generation    BIGINT NOT NULL DEFAULT 0 CHECK (user_catalog_generation >= 0),
    user_revocation_epoch      BIGINT NOT NULL DEFAULT 0 CHECK (user_revocation_epoch >= 0),
    provider_subject           TEXT NOT NULL UNIQUE,
    last_event_id              UUID,
    last_event_at              TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_extraction_runs (
    extraction_run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    idempotency_key            TEXT NOT NULL,
    request_digest             TEXT NOT NULL,
    session_id                 TEXT NOT NULL,
    thread_id                  TEXT NOT NULL,
    modality                   TEXT NOT NULL CHECK (modality IN ('text', 'voice', 'mixed', 'channel')),
    transcript_revision        BIGINT NOT NULL CHECK (transcript_revision >= 0),
    sequence_start             BIGINT NOT NULL CHECK (sequence_start > 0),
    sequence_end               BIGINT NOT NULL CHECK (sequence_end >= sequence_start),
    input_manifest_ref         TEXT NOT NULL,
    extractor_contract_version TEXT NOT NULL,
    extractor_model            TEXT NOT NULL,
    extractor_prompt_version   TEXT NOT NULL,
    state                      TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
        'queued', 'leased', 'retry_wait', 'succeeded_zero',
        'succeeded_nonzero', 'failed_terminal', 'superseded'
    )),
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner                TEXT,
    lease_token                UUID,
    lease_epoch                BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at           TIMESTAMPTZ,
    terminal_candidate_count   INTEGER CHECK (terminal_candidate_count >= 0),
    processed_through_sequence BIGINT CHECK (processed_through_sequence >= 0),
    safe_terminal_reason       TEXT,
    error_code                 TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    terminal_at                TIMESTAMPTZ,
    UNIQUE (user_id, idempotency_key),
    UNIQUE (
        user_id, session_id, transcript_revision, sequence_start, sequence_end,
        extractor_contract_version
    ),
    UNIQUE (user_id, extraction_run_id),
    CHECK (
        (state = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR state <> 'leased'
    ),
    CHECK (
        (state IN ('succeeded_zero', 'succeeded_nonzero') AND terminal_candidate_count IS NOT NULL AND processed_through_sequence = sequence_end)
        OR state NOT IN ('succeeded_zero', 'succeeded_nonzero')
    )
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_candidates (
    candidate_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    extraction_run_id          UUID NOT NULL,
    stable_ordinal             INTEGER NOT NULL CHECK (stable_ordinal >= 0),
    producer                   TEXT NOT NULL,
    origin                     TEXT NOT NULL,
    current_candidate_revision BIGINT NOT NULL DEFAULT 1 CHECK (current_candidate_revision > 0),
    review_state               TEXT NOT NULL DEFAULT 'pending_review' CHECK (review_state IN (
        'pending_review', 'approved', 'rejected', 'expired', 'legacy_quarantined'
    )),
    canonical_memory_id        UUID,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    reviewed_at                TIMESTAMPTZ,
    expired_at                 TIMESTAMPTZ,
    scrubbed_at                TIMESTAMPTZ,
    UNIQUE (user_id, candidate_id),
    UNIQUE (user_id, extraction_run_id, stable_ordinal),
    FOREIGN KEY (user_id, extraction_run_id)
        REFERENCES public.sophia_memory_extraction_runs(user_id, extraction_run_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_candidate_versions (
    candidate_version_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id               UUID NOT NULL,
    user_id                    TEXT NOT NULL,
    candidate_revision         BIGINT NOT NULL CHECK (candidate_revision > 0),
    proposed_content           TEXT,
    content_ref                TEXT,
    category                   TEXT NOT NULL,
    confidence                 DOUBLE PRECISION CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    importance                 DOUBLE PRECISION CHECK (importance IS NULL OR (importance >= 0 AND importance <= 1)),
    proposed_tier              TEXT CHECK (proposed_tier IS NULL OR proposed_tier IN ('conscious', 'subconscious', 'none')),
    creating_actor             TEXT NOT NULL,
    creation_reason            TEXT NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    scrubbed_at                TIMESTAMPTZ,
    UNIQUE (user_id, candidate_id, candidate_revision),
    FOREIGN KEY (user_id, candidate_id)
        REFERENCES public.sophia_memory_candidates(user_id, candidate_id)
        ON DELETE CASCADE,
    CHECK (
        (scrubbed_at IS NULL AND proposed_content IS NOT NULL AND content_ref IS NOT NULL)
        OR (scrubbed_at IS NOT NULL AND proposed_content IS NULL AND content_ref IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_candidate_sources (
    candidate_source_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id               UUID NOT NULL,
    user_id                    TEXT NOT NULL,
    session_id                 TEXT NOT NULL,
    message_id                 TEXT NOT NULL,
    sequence                   BIGINT NOT NULL CHECK (sequence > 0),
    transcript_revision        BIGINT NOT NULL CHECK (transcript_revision >= 0),
    detached_at                TIMESTAMPTZ,
    invalidated_at             TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, candidate_id, session_id, message_id, sequence),
    FOREIGN KEY (user_id, candidate_id)
        REFERENCES public.sophia_memory_candidates(user_id, candidate_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sophia_memories (
    memory_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    lifecycle                  TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'forgotten', 'tombstoned')),
    user_tier                  TEXT NOT NULL DEFAULT 'none' CHECK (user_tier IN ('conscious', 'subconscious', 'none')),
    current_content_revision   BIGINT NOT NULL DEFAULT 1 CHECK (current_content_revision > 0),
    memory_governance_revision BIGINT NOT NULL DEFAULT 1 CHECK (memory_governance_revision > 0),
    origin_candidate_id        UUID,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    forgotten_at               TIMESTAMPTZ,
    tombstoned_at              TIMESTAMPTZ,
    UNIQUE (user_id, memory_id),
    FOREIGN KEY (user_id, origin_candidate_id)
        REFERENCES public.sophia_memory_candidates(user_id, candidate_id)
        ON DELETE SET NULL
);

ALTER TABLE public.sophia_memory_candidates
    DROP CONSTRAINT IF EXISTS sophia_memory_candidates_canonical_owner_fk;
ALTER TABLE public.sophia_memory_candidates
    ADD CONSTRAINT sophia_memory_candidates_canonical_owner_fk
    FOREIGN KEY (user_id, canonical_memory_id)
    REFERENCES public.sophia_memories(user_id, memory_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS public.sophia_memory_versions (
    memory_version_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id                  UUID NOT NULL,
    user_id                    TEXT NOT NULL,
    content_revision           BIGINT NOT NULL CHECK (content_revision > 0),
    canonical_content          TEXT,
    content_ref                TEXT,
    category                   TEXT NOT NULL,
    scope                      TEXT NOT NULL,
    source_link_manifest       JSONB NOT NULL DEFAULT '[]'::jsonb,
    creation_actor             TEXT NOT NULL,
    creation_reason            TEXT NOT NULL,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    scrubbed_at                TIMESTAMPTZ,
    UNIQUE (user_id, memory_id, content_revision),
    FOREIGN KEY (user_id, memory_id)
        REFERENCES public.sophia_memories(user_id, memory_id)
        ON DELETE CASCADE,
    CHECK (
        (scrubbed_at IS NULL AND canonical_content IS NOT NULL AND content_ref IS NOT NULL)
        OR (scrubbed_at IS NOT NULL AND canonical_content IS NULL AND content_ref IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_governance_events (
    event_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id              TEXT NOT NULL,
    idempotency_key           TEXT NOT NULL,
    request_digest            TEXT NOT NULL,
    user_id                    TEXT NOT NULL,
    candidate_id               UUID,
    memory_id                  UUID,
    event_type                 TEXT NOT NULL,
    previous_lifecycle         TEXT,
    resulting_lifecycle        TEXT,
    content_revision           BIGINT,
    memory_governance_revision BIGINT,
    user_catalog_generation    BIGINT,
    user_revocation_epoch      BIGINT,
    actor_kind                 TEXT NOT NULL,
    safe_reason_code           TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, idempotency_key),
    FOREIGN KEY (user_id, candidate_id)
        REFERENCES public.sophia_memory_candidates(user_id, candidate_id)
        ON DELETE SET NULL,
    FOREIGN KEY (user_id, memory_id)
        REFERENCES public.sophia_memories(user_id, memory_id)
        ON DELETE SET NULL
);

ALTER TABLE public.sophia_memory_user_governance
    DROP CONSTRAINT IF EXISTS sophia_memory_user_governance_last_event_fk;
ALTER TABLE public.sophia_memory_user_governance
    ADD CONSTRAINT sophia_memory_user_governance_last_event_fk
    FOREIGN KEY (last_event_id) REFERENCES public.sophia_memory_governance_events(event_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS public.sophia_memory_projection_jobs (
    projection_job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    memory_id                  UUID NOT NULL,
    provider                   TEXT NOT NULL,
    environment                TEXT NOT NULL,
    provider_project           TEXT NOT NULL,
    provider_namespace         TEXT NOT NULL,
    desired_content_revision   BIGINT NOT NULL CHECK (desired_content_revision > 0),
    desired_governance_revision BIGINT NOT NULL CHECK (desired_governance_revision > 0),
    operation                  TEXT NOT NULL CHECK (operation IN ('project_revision', 'purge_binding', 'verify_binding')),
    state                      TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
        'queued', 'leased', 'ambiguous', 'active', 'stale', 'purge_queued',
        'purging', 'purged', 'failed_retryable', 'failed_terminal', 'orphaned'
    )),
    attempt_count              INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner                TEXT,
    lease_token                UUID,
    lease_epoch                BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at           TIMESTAMPTZ,
    projection_operation_id    TEXT NOT NULL,
    provider_result_class      TEXT,
    provider_error_class       TEXT,
    safe_reason_code           TEXT,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at               TIMESTAMPTZ,
    UNIQUE (
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_governance_revision, operation
    ),
    UNIQUE (projection_operation_id),
    UNIQUE (user_id, projection_job_id),
    FOREIGN KEY (user_id, memory_id)
        REFERENCES public.sophia_memories(user_id, memory_id)
        ON DELETE CASCADE,
    CHECK (
        (state IN ('leased', 'purging') AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR state NOT IN ('leased', 'purging')
    )
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_provider_bindings (
    provider_binding_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    memory_id                  UUID NOT NULL,
    provider                   TEXT NOT NULL,
    environment                TEXT NOT NULL,
    provider_project           TEXT NOT NULL,
    provider_namespace         TEXT NOT NULL,
    provider_memory_id         TEXT NOT NULL,
    canonical_content_revision BIGINT NOT NULL CHECK (canonical_content_revision > 0),
    memory_governance_revision BIGINT NOT NULL CHECK (memory_governance_revision > 0),
    projection_operation_id    TEXT NOT NULL,
    binding_state              TEXT NOT NULL CHECK (binding_state IN (
        'inactive', 'eligible', 'stale', 'purge_queued', 'purging', 'purged', 'orphaned', 'reconciliation_hold'
    )),
    metadata_verification_state TEXT NOT NULL CHECK (metadata_verification_state IN ('unverified', 'verified', 'failed', 'conflict')),
    last_verified_at           TIMESTAMPTZ,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, provider_memory_id
    ),
    FOREIGN KEY (user_id, memory_id)
        REFERENCES public.sophia_memories(user_id, memory_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_tombstones (
    tombstone_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    memory_id                  UUID NOT NULL,
    last_content_revision      BIGINT NOT NULL,
    tombstone_governance_revision BIGINT NOT NULL,
    user_revocation_epoch      BIGINT NOT NULL,
    source_refs                JSONB NOT NULL DEFAULT '[]'::jsonb,
    binding_refs               JSONB NOT NULL DEFAULT '[]'::jsonb,
    purge_status_summary       TEXT NOT NULL DEFAULT 'purge_pending',
    committed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, memory_id),
    FOREIGN KEY (user_id, memory_id)
        REFERENCES public.sophia_memories(user_id, memory_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_prompt_admissions (
    prompt_admission_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    retrieval_request_id       UUID NOT NULL,
    user_id                    TEXT NOT NULL,
    caller                     TEXT NOT NULL,
    scope                      TEXT NOT NULL,
    query_ref                  TEXT NOT NULL,
    provider_status            TEXT NOT NULL,
    provider_hit_count         INTEGER NOT NULL DEFAULT 0,
    catalog_generation_checked BIGINT NOT NULL,
    revocation_epoch_checked   BIGINT NOT NULL,
    authorized_manifest        JSONB NOT NULL DEFAULT '[]'::jsonb,
    denial_counts              JSONB NOT NULL DEFAULT '{}'::jsonb,
    outcome                    TEXT NOT NULL,
    safe_reason_code           TEXT,
    latency_segments           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sophia_memory_fault_settings (
    fault_setting_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                    TEXT NOT NULL,
    mode                       TEXT NOT NULL CHECK (mode IN (
        'extraction_claimant_crash', 'provider_timeout_before_effect',
        'provider_commit_response_loss', 'provider_429_5xx',
        'database_failure_after_provider_success', 'projection_lease_expiry',
        'provider_delete_blocked', 'cache_retained_through_tombstone',
        'langsmith_unavailable'
    )),
    remaining_uses             INTEGER NOT NULL DEFAULT 1 CHECK (remaining_uses IN (0, 1)),
    expires_at                 TIMESTAMPTZ NOT NULL,
    audit_ref                  TEXT NOT NULL CHECK (audit_ref LIKE 'hmac-sha256:%'),
    created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at                TIMESTAMPTZ,
    cleared_at                 TIMESTAMPTZ,
    UNIQUE (user_id, mode)
);

CREATE INDEX IF NOT EXISTS sophia_memory_extraction_claim_idx
    ON public.sophia_memory_extraction_runs(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS sophia_memory_candidate_review_idx
    ON public.sophia_memory_candidates(user_id, review_state, created_at);
CREATE INDEX IF NOT EXISTS sophia_memories_pool_idx
    ON public.sophia_memories(user_id, lifecycle, updated_at DESC);
CREATE INDEX IF NOT EXISTS sophia_memory_projection_claim_idx
    ON public.sophia_memory_projection_jobs(state, next_attempt_at, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS sophia_memory_binding_lookup_idx
    ON public.sophia_memory_provider_bindings(
        provider, environment, provider_project, provider_namespace,
        provider_memory_id, user_id, binding_state
    );
CREATE INDEX IF NOT EXISTS sophia_memory_tombstone_owner_idx
    ON public.sophia_memory_tombstones(user_id, committed_at DESC);

-- Content-free operational views for the five MEM00 dashboard planes. They
-- aggregate structural state only; no transcript, candidate, canonical, or
-- provider text is selected. The cleanup view is owner-scoped internally so
-- certification can query only its resolved synthetic principal.
CREATE OR REPLACE VIEW public.sophia_memory_extraction_freshness_v
WITH (security_invoker = true) AS
SELECT state,
       modality,
       count(*) AS run_count,
       min(created_at) AS oldest_created_at,
       max(updated_at) AS latest_updated_at,
       count(*) FILTER (WHERE state IN ('queued', 'leased', 'retry_wait')) AS nonterminal_count,
       count(*) FILTER (WHERE state = 'failed_terminal') AS terminal_failure_count
  FROM public.sophia_memory_extraction_runs
 GROUP BY state, modality;

CREATE OR REPLACE VIEW public.sophia_memory_lifecycle_transitions_v
WITH (security_invoker = true) AS
SELECT event_type,
       previous_lifecycle,
       resulting_lifecycle,
       actor_kind,
       safe_reason_code,
       count(*) AS transition_count,
       max(created_at) AS latest_transition_at
  FROM public.sophia_memory_governance_events
 GROUP BY event_type, previous_lifecycle, resulting_lifecycle, actor_kind, safe_reason_code;

CREATE OR REPLACE VIEW public.sophia_memory_projection_health_v
WITH (security_invoker = true) AS
SELECT provider,
       environment,
       provider_project,
       operation,
       state,
       provider_result_class,
       provider_error_class,
       safe_reason_code,
       count(*) AS job_count,
       min(created_at) AS oldest_created_at,
       max(updated_at) AS latest_updated_at
  FROM public.sophia_memory_projection_jobs
 GROUP BY provider, environment, provider_project, operation, state,
          provider_result_class, provider_error_class, safe_reason_code;

CREATE OR REPLACE VIEW public.sophia_memory_retrieval_authorization_v
WITH (security_invoker = true) AS
SELECT caller,
       provider_status,
       outcome,
       safe_reason_code,
       count(*) AS request_count,
       coalesce(sum(provider_hit_count), 0) AS provider_hit_count,
       max(created_at) AS latest_request_at
  FROM public.sophia_memory_prompt_admissions
 GROUP BY caller, provider_status, outcome, safe_reason_code;

CREATE OR REPLACE VIEW public.sophia_memory_certification_cleanup_v
WITH (security_invoker = true) AS
SELECT governance.user_id,
       contract.contract_epoch,
       contract.schema_version,
       contract.mode,
       governance.user_catalog_generation,
       governance.user_revocation_epoch,
       (SELECT count(*) FROM public.sophia_memory_candidate_versions version
         WHERE version.user_id = governance.user_id AND version.scrubbed_at IS NULL) AS live_candidate_plaintext_count,
       (SELECT count(*) FROM public.sophia_memory_versions version
         WHERE version.user_id = governance.user_id AND version.scrubbed_at IS NULL) AS live_canonical_plaintext_count,
       (SELECT count(*) FROM public.sophia_memory_candidates candidate
         WHERE candidate.user_id = governance.user_id AND candidate.review_state = 'pending_review') AS active_candidate_count,
       (SELECT count(*) FROM public.sophia_memories memory
         WHERE memory.user_id = governance.user_id AND memory.lifecycle <> 'tombstoned') AS active_canonical_count,
       (SELECT count(*) FROM public.sophia_memory_provider_bindings binding
         WHERE binding.user_id = governance.user_id AND binding.binding_state <> 'purged') AS nonterminal_binding_count,
       (SELECT count(*) FROM public.sophia_memory_projection_jobs job
         WHERE job.user_id = governance.user_id
           AND job.state NOT IN ('active', 'stale', 'purged', 'failed_terminal', 'orphaned')) AS nonterminal_job_count,
       (SELECT count(*) FROM public.sophia_memory_fault_settings fault
         WHERE fault.user_id = governance.user_id
           AND fault.remaining_uses > 0
           AND fault.cleared_at IS NULL
           AND fault.expires_at > now()) AS active_fault_setting_count,
       (SELECT count(*) FROM public.sophia_memory_governance_events event
         WHERE event.user_id = governance.user_id) AS retained_event_receipt_count,
       (SELECT count(*) FROM public.sophia_memory_tombstones tombstone
         WHERE tombstone.user_id = governance.user_id) AS retained_tombstone_receipt_count
  FROM public.sophia_memory_user_governance governance
 CROSS JOIN public.sophia_memory_contract contract
 WHERE contract.singleton = true;

-- These tables are backend authorities. Browsers use authenticated Gateway
-- service methods; they never mutate or select the tables directly.
DO $mem00_acl$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'sophia_memory_contract',
        'sophia_memory_user_governance',
        'sophia_memory_extraction_runs',
        'sophia_memory_candidates',
        'sophia_memory_candidate_versions',
        'sophia_memory_candidate_sources',
        'sophia_memories',
        'sophia_memory_versions',
        'sophia_memory_governance_events',
        'sophia_memory_projection_jobs',
        'sophia_memory_provider_bindings',
        'sophia_memory_tombstones',
        'sophia_memory_prompt_admissions',
        'sophia_memory_fault_settings'
    ]
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', table_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', table_name);
    END LOOP;
END
$mem00_acl$;

DO $mem00_view_acl$
DECLARE
    view_name TEXT;
BEGIN
    FOREACH view_name IN ARRAY ARRAY[
        'sophia_memory_extraction_freshness_v',
        'sophia_memory_lifecycle_transitions_v',
        'sophia_memory_projection_health_v',
        'sophia_memory_retrieval_authorization_v',
        'sophia_memory_certification_cleanup_v'
    ]
    LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', view_name);
        EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role', view_name);
    END LOOP;
END
$mem00_view_acl$;

CREATE OR REPLACE FUNCTION public.sophia_memory_ensure_governance(p_user_id TEXT)
RETURNS public.sophia_memory_user_governance
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    result public.sophia_memory_user_governance;
BEGIN
    IF p_user_id IS NULL OR length(btrim(p_user_id)) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_owner_invalid';
    END IF;
    INSERT INTO public.sophia_memory_user_governance(user_id, provider_subject)
    VALUES (p_user_id, 'sophia-memory-v2-' || replace(gen_random_uuid()::text, '-', ''))
    ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO STRICT result
      FROM public.sophia_memory_user_governance
     WHERE user_id = p_user_id
     FOR UPDATE;
    RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_invalidate_source(
    p_user_id TEXT,
    p_session_id TEXT,
    p_current_transcript_revision BIGINT,
    p_detach_source BOOLEAN,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_safe_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    invalidated_candidate_ids UUID[] := ARRAY[]::UUID[];
    invalidated_candidate_count INTEGER := 0;
    invalidated_run_count INTEGER := 0;
    detached_manifest_count INTEGER := 0;
BEGIN
    IF p_user_id IS NULL OR length(btrim(p_user_id)) = 0
       OR p_session_id IS NULL OR length(btrim(p_session_id)) = 0 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_source_identity_invalid';
    END IF;
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id,
            'invalidated_candidate_count', 0,
            'invalidated_run_count', 0,
            'detached_manifest_count', 0,
            'idempotent_replay', true
        );
    END IF;

    PERFORM public.sophia_memory_ensure_governance(p_user_id);
    SELECT coalesce(array_agg(DISTINCT candidate.candidate_id), ARRAY[]::UUID[])
      INTO invalidated_candidate_ids
      FROM public.sophia_memory_candidates candidate
      JOIN public.sophia_memory_candidate_sources source
        ON source.user_id = candidate.user_id
       AND source.candidate_id = candidate.candidate_id
     WHERE candidate.user_id = p_user_id
       AND source.session_id = p_session_id
       AND source.invalidated_at IS NULL
       AND candidate.review_state = 'pending_review'
       AND (
           p_current_transcript_revision IS NULL
           OR source.transcript_revision <> p_current_transcript_revision
       );

    UPDATE public.sophia_memory_candidate_sources
       SET invalidated_at = coalesce(invalidated_at, now()),
           detached_at = CASE WHEN p_detach_source THEN coalesce(detached_at, now()) ELSE detached_at END
     WHERE user_id = p_user_id
       AND session_id = p_session_id
       AND invalidated_at IS NULL
       AND (
           p_current_transcript_revision IS NULL
           OR transcript_revision <> p_current_transcript_revision
       );

    UPDATE public.sophia_memory_candidates
       SET review_state = 'expired', expired_at = now(), scrubbed_at = now()
     WHERE user_id = p_user_id
       AND candidate_id = ANY(invalidated_candidate_ids)
       AND review_state = 'pending_review';
    GET DIAGNOSTICS invalidated_candidate_count = ROW_COUNT;

    UPDATE public.sophia_memory_candidate_versions
       SET proposed_content = NULL, content_ref = NULL, scrubbed_at = now()
     WHERE user_id = p_user_id
       AND candidate_id = ANY(invalidated_candidate_ids)
       AND scrubbed_at IS NULL;

    UPDATE public.sophia_memory_extraction_runs
       SET state = 'superseded', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, terminal_at = coalesce(terminal_at, now()),
           updated_at = now(), safe_terminal_reason = p_safe_reason_code
     WHERE user_id = p_user_id
       AND session_id = p_session_id
       AND state <> 'superseded'
       AND (
           p_current_transcript_revision IS NULL
           OR transcript_revision <> p_current_transcript_revision
       );
    GET DIAGNOSTICS invalidated_run_count = ROW_COUNT;

    WITH rewritten AS (
        SELECT version.memory_version_id,
               coalesce(jsonb_agg(entry.value) FILTER (
                   WHERE NOT (
                       entry.value->>'session_id' = p_session_id
                       AND (
                           p_current_transcript_revision IS NULL
                           OR nullif(entry.value->>'transcript_revision', '')::BIGINT <> p_current_transcript_revision
                       )
                   )
               ), '[]'::jsonb) AS retained_manifest
          FROM public.sophia_memory_versions version
          CROSS JOIN LATERAL jsonb_array_elements(version.source_link_manifest) entry(value)
         WHERE version.user_id = p_user_id
           AND jsonb_typeof(version.source_link_manifest) = 'array'
           AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(version.source_link_manifest) matched(value)
                WHERE matched.value->>'session_id' = p_session_id
                  AND (
                      p_current_transcript_revision IS NULL
                      OR nullif(matched.value->>'transcript_revision', '')::BIGINT <> p_current_transcript_revision
                  )
           )
         GROUP BY version.memory_version_id
    )
    UPDATE public.sophia_memory_versions version
       SET source_link_manifest = rewritten.retained_manifest
      FROM rewritten
     WHERE version.memory_version_id = rewritten.memory_version_id;
    GET DIAGNOSTICS detached_manifest_count = ROW_COUNT;

    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        event_type, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, 'memop-' || replace(gen_random_uuid()::text, '-', ''),
        p_idempotency_key, p_request_digest, p_user_id,
        'source_invalidated', p_actor_kind, p_safe_reason_code
    );

    RETURN jsonb_build_object(
        'event_id', new_event_id,
        'invalidated_candidate_count', invalidated_candidate_count,
        'invalidated_run_count', invalidated_run_count,
        'detached_manifest_count', detached_manifest_count,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_enqueue_extraction(
    p_user_id TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_session_id TEXT,
    p_thread_id TEXT,
    p_modality TEXT,
    p_transcript_revision BIGINT,
    p_sequence_start BIGINT,
    p_sequence_end BIGINT,
    p_input_manifest_ref TEXT,
    p_extractor_contract_version TEXT,
    p_extractor_model TEXT,
    p_extractor_prompt_version TEXT
)
RETURNS public.sophia_memory_extraction_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    result public.sophia_memory_extraction_runs;
BEGIN
    PERFORM public.sophia_memory_ensure_governance(p_user_id);
    PERFORM public.sophia_memory_invalidate_source(
        p_user_id,
        p_session_id,
        p_transcript_revision,
        false,
        'system',
        p_idempotency_key || ':source-revision-fence',
        p_request_digest,
        'source_transcript_revised'
    );
    INSERT INTO public.sophia_memory_extraction_runs(
        user_id, idempotency_key, request_digest, session_id, thread_id,
        modality, transcript_revision, sequence_start, sequence_end,
        input_manifest_ref, extractor_contract_version, extractor_model,
        extractor_prompt_version
    ) VALUES (
        p_user_id, p_idempotency_key, p_request_digest, p_session_id, p_thread_id,
        p_modality, p_transcript_revision, p_sequence_start, p_sequence_end,
        p_input_manifest_ref, p_extractor_contract_version, p_extractor_model,
        p_extractor_prompt_version
    )
    ON CONFLICT (user_id, idempotency_key) DO NOTHING;

    SELECT * INTO STRICT result
      FROM public.sophia_memory_extraction_runs
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF result.request_digest <> p_request_digest THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
    END IF;
    RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_finalize_and_enqueue_extraction(
    p_user_id TEXT,
    p_session_id TEXT,
    p_thread_id TEXT,
    p_ended_at TIMESTAMPTZ,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_modality TEXT,
    p_transcript_revision BIGINT,
    p_sequence_start BIGINT,
    p_sequence_end BIGINT,
    p_input_manifest_ref TEXT,
    p_extractor_contract_version TEXT,
    p_extractor_model TEXT,
    p_extractor_prompt_version TEXT
)
RETURNS public.sophia_memory_extraction_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    session_record public.sophia_sessions%ROWTYPE;
    durable_sequence_start BIGINT;
    durable_sequence_end BIGINT;
    result public.sophia_memory_extraction_runs;
BEGIN
    SELECT * INTO session_record
      FROM public.sophia_sessions
     WHERE id = p_session_id AND user_id = p_user_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'memory_session_not_found';
    END IF;
    IF session_record.thread_id <> p_thread_id
       OR session_record.message_revision <> p_transcript_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_session_revision_conflict';
    END IF;

    SELECT min(message.sequence), max(message.sequence)
      INTO durable_sequence_start, durable_sequence_end
      FROM public.sophia_session_messages message
     WHERE message.user_id = p_user_id
       AND message.session_id = p_session_id
       AND message.role IN ('user', 'assistant')
       AND message.final
       AND length(btrim(message.content)) > 0
       AND message.sequence > session_record.memory_processed_until_sequence;
    IF durable_sequence_start IS NULL
       OR durable_sequence_start <> p_sequence_start
       OR durable_sequence_end <> p_sequence_end THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_extraction_range_conflict';
    END IF;

    UPDATE public.sophia_sessions
       SET status = 'ended',
           ended_at = coalesce(ended_at, p_ended_at),
           updated_at = now()
     WHERE id = p_session_id AND user_id = p_user_id;

    SELECT * INTO STRICT result
      FROM public.sophia_memory_enqueue_extraction(
          p_user_id,
          p_idempotency_key,
          p_request_digest,
          p_session_id,
          p_thread_id,
          p_modality,
          p_transcript_revision,
          p_sequence_start,
          p_sequence_end,
          p_input_manifest_ref,
          p_extractor_contract_version,
          p_extractor_model,
          p_extractor_prompt_version
      );
    RETURN result;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_claim_extraction(
    p_lease_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.sophia_memory_extraction_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF p_lease_seconds < 10 OR p_lease_seconds > 600 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_lease_seconds_invalid';
    END IF;
    RETURN QUERY
    WITH chosen AS (
        SELECT extraction_run_id
          FROM public.sophia_memory_extraction_runs
         WHERE (
             state IN ('queued', 'retry_wait') AND next_attempt_at <= now()
         ) OR (
             state = 'leased' AND lease_expires_at <= now()
         )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    )
    UPDATE public.sophia_memory_extraction_runs run
       SET state = 'leased',
           attempt_count = run.attempt_count + 1,
           lease_owner = p_lease_owner,
           lease_token = gen_random_uuid(),
           lease_epoch = run.lease_epoch + 1,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds),
           updated_at = now()
      FROM chosen
     WHERE run.extraction_run_id = chosen.extraction_run_id
    RETURNING run.*;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_complete_extraction(
    p_user_id TEXT,
    p_extraction_run_id UUID,
    p_lease_token UUID,
    p_input_manifest_ref TEXT,
    p_candidates JSONB
)
RETURNS public.sophia_memory_extraction_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    run public.sophia_memory_extraction_runs;
    candidate JSONB;
    new_candidate_id UUID;
    candidate_count INTEGER := 0;
BEGIN
    SELECT * INTO STRICT run
      FROM public.sophia_memory_extraction_runs
     WHERE user_id = p_user_id AND extraction_run_id = p_extraction_run_id
     FOR UPDATE;
    IF run.state IN ('succeeded_zero', 'succeeded_nonzero') THEN
        RETURN run;
    END IF;
    IF run.state <> 'leased' OR run.lease_token <> p_lease_token OR run.lease_expires_at <= now() THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_extraction_lease_stale';
    END IF;
    IF run.input_manifest_ref <> p_input_manifest_ref THEN
        UPDATE public.sophia_memory_extraction_runs
           SET state = 'superseded', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, terminal_at = now(), updated_at = now(),
               safe_terminal_reason = 'transcript_manifest_changed'
         WHERE extraction_run_id = run.extraction_run_id;
        SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
         WHERE extraction_run_id = run.extraction_run_id;
        RETURN run;
    END IF;
    IF jsonb_typeof(p_candidates) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_candidate_batch_invalid';
    END IF;

    FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidates)
    LOOP
        IF nullif(candidate->>'content', '') IS NULL OR nullif(candidate->>'content_ref', '') IS NULL THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_candidate_content_invalid';
        END IF;
        INSERT INTO public.sophia_memory_candidates(
            user_id, extraction_run_id, stable_ordinal, producer, origin
        ) VALUES (
            p_user_id, run.extraction_run_id, candidate_count,
            coalesce(nullif(candidate->>'producer', ''), 'memory_extraction_service'),
            coalesce(nullif(candidate->>'origin', ''), 'session_extraction')
        ) RETURNING candidate_id INTO new_candidate_id;

        INSERT INTO public.sophia_memory_candidate_versions(
            candidate_id, user_id, candidate_revision, proposed_content,
            content_ref, category, confidence, importance, proposed_tier,
            creating_actor, creation_reason
        ) VALUES (
            new_candidate_id, p_user_id, 1, candidate->>'content',
            candidate->>'content_ref', coalesce(nullif(candidate->>'category', ''), 'fact'),
            CASE WHEN candidate ? 'confidence' THEN (candidate->>'confidence')::double precision ELSE NULL END,
            CASE WHEN candidate ? 'importance' THEN (candidate->>'importance')::double precision ELSE NULL END,
            nullif(candidate->>'proposed_tier', ''), 'extractor', 'durable_session_extraction'
        );

        INSERT INTO public.sophia_memory_candidate_sources(
            candidate_id, user_id, session_id, message_id, sequence, transcript_revision
        )
        SELECT new_candidate_id, p_user_id, run.session_id,
               source->>'message_id', (source->>'sequence')::bigint, run.transcript_revision
          FROM jsonb_array_elements(coalesce(candidate->'sources', '[]'::jsonb)) source;
        candidate_count := candidate_count + 1;
    END LOOP;

    UPDATE public.sophia_memory_extraction_runs
       SET state = CASE WHEN candidate_count = 0 THEN 'succeeded_zero' ELSE 'succeeded_nonzero' END,
           terminal_candidate_count = candidate_count,
           processed_through_sequence = sequence_end,
           safe_terminal_reason = CASE WHEN candidate_count = 0 THEN 'no_candidate' ELSE 'candidate_batch_committed' END,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           terminal_at = now(), updated_at = now()
     WHERE extraction_run_id = run.extraction_run_id;

    UPDATE public.sophia_sessions
       SET memory_processed_until_sequence = GREATEST(memory_processed_until_sequence, run.sequence_end),
           recap_processed_until_sequence = GREATEST(recap_processed_until_sequence, run.sequence_end),
           last_memory_extraction_at = now(), last_recap_extraction_at = now(),
           last_memory_extraction_run_id = run.extraction_run_id::text,
           memory_extraction_status = CASE WHEN candidate_count = 0 THEN 'succeeded_zero' ELSE 'succeeded_nonzero' END,
           memory_extraction_error_code = NULL,
           memory_extraction_range_start = run.sequence_start,
           memory_extraction_range_end = run.sequence_end,
           updated_at = now()
     WHERE id = run.session_id AND user_id = p_user_id
       AND message_revision = run.transcript_revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_transcript_revision_stale';
    END IF;

    SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
     WHERE extraction_run_id = run.extraction_run_id;
    RETURN run;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_approve_candidate(
    p_user_id TEXT,
    p_candidate_id UUID,
    p_expected_candidate_revision BIGINT,
    p_reviewed_content TEXT,
    p_reviewed_content_ref TEXT,
    p_category TEXT,
    p_scope TEXT,
    p_user_tier TEXT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_provider TEXT,
    p_environment TEXT,
    p_provider_project TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    candidate public.sophia_memory_candidates;
    current_version public.sophia_memory_candidate_versions;
    event public.sophia_memory_governance_events;
    new_memory_id UUID := gen_random_uuid();
    new_event_id UUID := gen_random_uuid();
    new_candidate_revision BIGINT;
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'memory_id', event.memory_id,
            'candidate_id', event.candidate_id, 'content_revision', event.content_revision,
            'memory_governance_revision', event.memory_governance_revision,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;

    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT candidate FROM public.sophia_memory_candidates
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id FOR UPDATE;
    IF candidate.review_state <> 'pending_review' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_candidate_not_pending';
    END IF;
    IF candidate.current_candidate_revision <> p_expected_candidate_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_candidate_revision_stale';
    END IF;
    SELECT * INTO STRICT current_version FROM public.sophia_memory_candidate_versions
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id
       AND candidate_revision = p_expected_candidate_revision FOR UPDATE;

    new_candidate_revision := p_expected_candidate_revision;
    IF current_version.content_ref <> p_reviewed_content_ref THEN
        new_candidate_revision := p_expected_candidate_revision + 1;
        INSERT INTO public.sophia_memory_candidate_versions(
            candidate_id, user_id, candidate_revision, proposed_content, content_ref,
            category, confidence, importance, proposed_tier, creating_actor, creation_reason
        ) VALUES (
            p_candidate_id, p_user_id, new_candidate_revision, p_reviewed_content,
            p_reviewed_content_ref, p_category, current_version.confidence,
            current_version.importance, p_user_tier, p_actor_kind, 'review_edit'
        );
        UPDATE public.sophia_memory_candidates
           SET current_candidate_revision = new_candidate_revision
         WHERE user_id = p_user_id AND candidate_id = p_candidate_id;
    ELSIF current_version.proposed_content IS DISTINCT FROM p_reviewed_content THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_reviewed_content_reference_mismatch';
    END IF;

    INSERT INTO public.sophia_memories(
        memory_id, user_id, lifecycle, user_tier, current_content_revision,
        memory_governance_revision, origin_candidate_id
    ) VALUES (new_memory_id, p_user_id, 'active', p_user_tier, 1, 1, p_candidate_id);
    INSERT INTO public.sophia_memory_versions(
        memory_id, user_id, content_revision, canonical_content, content_ref,
        category, scope, source_link_manifest, creation_actor, creation_reason
    )
    SELECT new_memory_id, p_user_id, 1, p_reviewed_content, p_reviewed_content_ref,
           p_category, p_scope,
           coalesce(jsonb_agg(jsonb_build_object(
               'session_id', source.session_id, 'message_id', source.message_id,
               'sequence', source.sequence, 'transcript_revision', source.transcript_revision
           )) FILTER (WHERE source.candidate_source_id IS NOT NULL), '[]'::jsonb),
           p_actor_kind, 'candidate_approval'
      FROM public.sophia_memory_candidate_sources source
     WHERE source.user_id = p_user_id AND source.candidate_id = p_candidate_id;

    UPDATE public.sophia_memory_candidates
       SET review_state = 'approved', canonical_memory_id = new_memory_id,
           reviewed_at = now(), scrubbed_at = now()
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id;
    UPDATE public.sophia_memory_candidate_versions
       SET proposed_content = NULL, content_ref = NULL, scrubbed_at = now()
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id;

    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1,
           updated_at = now()
     WHERE user_id = p_user_id
     RETURNING * INTO governance;

    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        candidate_id, memory_id, event_type, resulting_lifecycle,
        content_revision, memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_candidate_id, new_memory_id, 'candidate_approved', 'active', 1, 1,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        p_actor_kind, 'approved_by_user'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;

    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    ) VALUES (
        p_user_id, new_memory_id, p_provider, p_environment, p_provider_project,
        governance.provider_subject, 1, 1, 'project_revision', 'queued', operation_id
    );

    RETURN jsonb_build_object(
        'event_id', new_event_id, 'memory_id', new_memory_id,
        'candidate_id', p_candidate_id, 'content_revision', 1,
        'memory_governance_revision', 1,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_tombstone(
    p_user_id TEXT,
    p_memory_id UUID,
    p_expected_governance_revision BIGINT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    memory public.sophia_memories;
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    new_tombstone_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
    binding_manifest JSONB;
    prior_lifecycle TEXT;
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object('status', 'accepted_and_fenced', 'event_id', event.event_id,
            'memory_id', event.memory_id, 'idempotent_replay', true);
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT memory FROM public.sophia_memories
     WHERE user_id = p_user_id AND memory_id = p_memory_id FOR UPDATE;
    IF memory.lifecycle = 'tombstoned' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_already_tombstoned_without_receipt';
    END IF;
    IF memory.memory_governance_revision <> p_expected_governance_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_governance_revision_stale';
    END IF;
    prior_lifecycle := memory.lifecycle;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'provider_binding_id', provider_binding_id,
        'provider_memory_ref', provider_memory_id,
        'projection_operation_id', projection_operation_id
    )), '[]'::jsonb) INTO binding_manifest
      FROM public.sophia_memory_provider_bindings
     WHERE user_id = p_user_id AND memory_id = p_memory_id;

    UPDATE public.sophia_memories
       SET lifecycle = 'tombstoned',
           memory_governance_revision = memory_governance_revision + 1,
           tombstoned_at = now(), updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id
     RETURNING * INTO memory;
    UPDATE public.sophia_memory_versions
       SET canonical_content = NULL, content_ref = NULL, scrubbed_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_candidate_versions version
       SET proposed_content = NULL, content_ref = NULL, scrubbed_at = now()
      FROM public.sophia_memory_candidates candidate
     WHERE candidate.user_id = p_user_id
       AND candidate.canonical_memory_id = p_memory_id
       AND version.user_id = candidate.user_id
       AND version.candidate_id = candidate.candidate_id;
    UPDATE public.sophia_memory_provider_bindings
       SET binding_state = 'purge_queued', updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id
       AND binding_state <> 'purged';
    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1,
           user_revocation_epoch = user_revocation_epoch + 1,
           updated_at = now()
     WHERE user_id = p_user_id RETURNING * INTO governance;

    INSERT INTO public.sophia_memory_tombstones(
        tombstone_id, user_id, memory_id, last_content_revision,
        tombstone_governance_revision, user_revocation_epoch,
        binding_refs, purge_status_summary
    ) VALUES (
        new_tombstone_id, p_user_id, p_memory_id, memory.current_content_revision,
        memory.memory_governance_revision, governance.user_revocation_epoch,
        binding_manifest, 'purge_pending'
    );
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        memory_id, event_type, previous_lifecycle, resulting_lifecycle,
        content_revision, memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_memory_id, 'memory_tombstoned', prior_lifecycle, 'tombstoned',
        memory.current_content_revision, memory.memory_governance_revision,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        p_actor_kind, 'accepted_and_fenced'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    )
    SELECT p_user_id, p_memory_id, provider, environment, provider_project,
           provider_namespace, memory.current_content_revision,
           memory.memory_governance_revision, 'purge_binding', 'purge_queued', operation_id
      FROM public.sophia_memory_provider_bindings
     WHERE user_id = p_user_id AND memory_id = p_memory_id
     GROUP BY provider, environment, provider_project, provider_namespace
    ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object(
        'status', 'accepted_and_fenced', 'event_id', new_event_id,
        'tombstone_id', new_tombstone_id, 'memory_id', p_memory_id,
        'content_revision', memory.current_content_revision,
        'memory_governance_revision', memory.memory_governance_revision,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'provider_purge', 'purge_pending', 'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_reject_candidate(
    p_user_id TEXT,
    p_candidate_id UUID,
    p_expected_candidate_revision BIGINT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    candidate public.sophia_memory_candidates;
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'candidate_id', event.candidate_id,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT candidate FROM public.sophia_memory_candidates
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id FOR UPDATE;
    IF candidate.review_state <> 'pending_review' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_candidate_not_pending';
    END IF;
    IF candidate.current_candidate_revision <> p_expected_candidate_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_candidate_revision_stale';
    END IF;
    UPDATE public.sophia_memory_candidates
       SET review_state = 'rejected', reviewed_at = now(), scrubbed_at = now()
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id;
    UPDATE public.sophia_memory_candidate_versions
       SET proposed_content = NULL, content_ref = NULL, scrubbed_at = now()
     WHERE user_id = p_user_id AND candidate_id = p_candidate_id;
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        candidate_id, event_type, actor_kind, safe_reason_code,
        user_catalog_generation, user_revocation_epoch
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_candidate_id, 'candidate_rejected', p_actor_kind, 'rejected_by_user',
        governance.user_catalog_generation, governance.user_revocation_epoch
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now(), updated_at = now()
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
        'event_id', new_event_id, 'candidate_id', p_candidate_id,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_manual_create(
    p_user_id TEXT,
    p_canonical_content TEXT,
    p_content_ref TEXT,
    p_category TEXT,
    p_scope TEXT,
    p_user_tier TEXT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_provider TEXT,
    p_environment TEXT,
    p_provider_project TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    event public.sophia_memory_governance_events;
    new_memory_id UUID := gen_random_uuid();
    new_event_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'memory_id', event.memory_id,
            'content_revision', event.content_revision,
            'memory_governance_revision', event.memory_governance_revision,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;
    IF nullif(p_canonical_content, '') IS NULL OR nullif(p_content_ref, '') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_content_invalid';
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    INSERT INTO public.sophia_memories(
        memory_id, user_id, lifecycle, user_tier,
        current_content_revision, memory_governance_revision
    ) VALUES (new_memory_id, p_user_id, 'active', p_user_tier, 1, 1);
    INSERT INTO public.sophia_memory_versions(
        memory_id, user_id, content_revision, canonical_content, content_ref,
        category, scope, creation_actor, creation_reason
    ) VALUES (
        new_memory_id, p_user_id, 1, p_canonical_content, p_content_ref,
        p_category, p_scope, p_actor_kind, 'manual_user_create'
    );
    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1, updated_at = now()
     WHERE user_id = p_user_id RETURNING * INTO governance;
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        memory_id, event_type, resulting_lifecycle, content_revision,
        memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        new_memory_id, 'memory_manual_created', 'active', 1, 1,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        p_actor_kind, 'explicit_user_save'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    ) VALUES (
        p_user_id, new_memory_id, p_provider, p_environment, p_provider_project,
        governance.provider_subject, 1, 1, 'project_revision', 'queued', operation_id
    );
    RETURN jsonb_build_object(
        'event_id', new_event_id, 'memory_id', new_memory_id,
        'content_revision', 1, 'memory_governance_revision', 1,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_edit(
    p_user_id TEXT,
    p_memory_id UUID,
    p_expected_content_revision BIGINT,
    p_expected_governance_revision BIGINT,
    p_canonical_content TEXT,
    p_content_ref TEXT,
    p_category TEXT,
    p_scope TEXT,
    p_user_tier TEXT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_provider TEXT,
    p_environment TEXT,
    p_provider_project TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    memory public.sophia_memories;
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
    next_content_revision BIGINT;
    next_governance_revision BIGINT;
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'memory_id', event.memory_id,
            'content_revision', event.content_revision,
            'memory_governance_revision', event.memory_governance_revision,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;
    IF nullif(p_canonical_content, '') IS NULL OR nullif(p_content_ref, '') IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_content_invalid';
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT memory FROM public.sophia_memories
     WHERE user_id = p_user_id AND memory_id = p_memory_id FOR UPDATE;
    IF memory.lifecycle <> 'active' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_not_editable';
    END IF;
    IF memory.current_content_revision <> p_expected_content_revision
       OR memory.memory_governance_revision <> p_expected_governance_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_revision_stale';
    END IF;
    next_content_revision := memory.current_content_revision + 1;
    next_governance_revision := memory.memory_governance_revision + 1;
    INSERT INTO public.sophia_memory_versions(
        memory_id, user_id, content_revision, canonical_content, content_ref,
        category, scope, creation_actor, creation_reason
    ) VALUES (
        p_memory_id, p_user_id, next_content_revision, p_canonical_content,
        p_content_ref, p_category, p_scope, p_actor_kind, 'canonical_edit'
    );
    UPDATE public.sophia_memories
       SET user_tier = p_user_tier,
           current_content_revision = next_content_revision,
           memory_governance_revision = next_governance_revision,
           updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_provider_bindings
       SET binding_state = CASE WHEN binding_state = 'purged' THEN 'purged' ELSE 'stale' END,
           updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1,
           user_revocation_epoch = user_revocation_epoch + 1,
           updated_at = now()
     WHERE user_id = p_user_id RETURNING * INTO governance;
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        memory_id, event_type, previous_lifecycle, resulting_lifecycle,
        content_revision, memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_memory_id, 'memory_edited', 'active', 'active', next_content_revision,
        next_governance_revision, governance.user_catalog_generation,
        governance.user_revocation_epoch, p_actor_kind, 'canonical_revision_created'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    ) VALUES (
        p_user_id, p_memory_id, p_provider, p_environment, p_provider_project,
        governance.provider_subject, next_content_revision, next_governance_revision,
        'project_revision', 'queued', operation_id
    );
    RETURN jsonb_build_object(
        'event_id', new_event_id, 'memory_id', p_memory_id,
        'content_revision', next_content_revision,
        'memory_governance_revision', next_governance_revision,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_forget(
    p_user_id TEXT,
    p_memory_id UUID,
    p_expected_governance_revision BIGINT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    memory public.sophia_memories;
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
    next_governance_revision BIGINT;
BEGIN
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'memory_id', event.memory_id,
            'content_revision', event.content_revision,
            'memory_governance_revision', event.memory_governance_revision,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT memory FROM public.sophia_memories
     WHERE user_id = p_user_id AND memory_id = p_memory_id FOR UPDATE;
    IF memory.lifecycle <> 'active' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_not_active';
    END IF;
    IF memory.memory_governance_revision <> p_expected_governance_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_governance_revision_stale';
    END IF;
    next_governance_revision := memory.memory_governance_revision + 1;
    UPDATE public.sophia_memories
       SET lifecycle = 'forgotten', memory_governance_revision = next_governance_revision,
           forgotten_at = now(), updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_provider_bindings
       SET binding_state = CASE WHEN binding_state = 'purged' THEN 'purged' ELSE 'purge_queued' END,
           updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1,
           user_revocation_epoch = user_revocation_epoch + 1, updated_at = now()
     WHERE user_id = p_user_id RETURNING * INTO governance;
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        memory_id, event_type, previous_lifecycle, resulting_lifecycle,
        content_revision, memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_memory_id, 'memory_forgotten', 'active', 'forgotten',
        memory.current_content_revision, next_governance_revision,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        p_actor_kind, 'forgotten_by_user'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    )
    SELECT p_user_id, p_memory_id, provider, environment, provider_project,
           provider_namespace, memory.current_content_revision,
           next_governance_revision, 'purge_binding', 'purge_queued', operation_id
      FROM public.sophia_memory_provider_bindings
     WHERE user_id = p_user_id AND memory_id = p_memory_id
     GROUP BY provider, environment, provider_project, provider_namespace
    ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object(
        'event_id', new_event_id, 'memory_id', p_memory_id,
        'content_revision', memory.current_content_revision,
        'memory_governance_revision', next_governance_revision,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'provider_purge', 'purge_pending', 'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_restore(
    p_user_id TEXT,
    p_memory_id UUID,
    p_expected_governance_revision BIGINT,
    p_actor_kind TEXT,
    p_idempotency_key TEXT,
    p_request_digest TEXT,
    p_provider TEXT,
    p_environment TEXT,
    p_provider_project TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    governance public.sophia_memory_user_governance;
    memory public.sophia_memories;
    event public.sophia_memory_governance_events;
    new_event_id UUID := gen_random_uuid();
    operation_id TEXT := 'memop-' || replace(gen_random_uuid()::text, '-', '');
    next_governance_revision BIGINT;
BEGIN
    IF p_actor_kind <> 'user' THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'memory_restore_user_only';
    END IF;
    SELECT * INTO event FROM public.sophia_memory_governance_events
     WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF event.request_digest <> p_request_digest THEN
            RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'memory_idempotency_digest_conflict';
        END IF;
        RETURN jsonb_build_object(
            'event_id', event.event_id, 'memory_id', event.memory_id,
            'content_revision', event.content_revision,
            'memory_governance_revision', event.memory_governance_revision,
            'user_catalog_generation', event.user_catalog_generation,
            'user_revocation_epoch', event.user_revocation_epoch,
            'idempotent_replay', true
        );
    END IF;
    governance := public.sophia_memory_ensure_governance(p_user_id);
    SELECT * INTO STRICT memory FROM public.sophia_memories
     WHERE user_id = p_user_id AND memory_id = p_memory_id FOR UPDATE;
    IF memory.lifecycle <> 'forgotten' THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_not_forgotten';
    END IF;
    IF memory.memory_governance_revision <> p_expected_governance_revision THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_governance_revision_stale';
    END IF;
    next_governance_revision := memory.memory_governance_revision + 1;
    UPDATE public.sophia_memories
       SET lifecycle = 'active', memory_governance_revision = next_governance_revision,
           forgotten_at = NULL, updated_at = now()
     WHERE user_id = p_user_id AND memory_id = p_memory_id;
    UPDATE public.sophia_memory_user_governance
       SET user_catalog_generation = user_catalog_generation + 1, updated_at = now()
     WHERE user_id = p_user_id RETURNING * INTO governance;
    INSERT INTO public.sophia_memory_governance_events(
        event_id, operation_id, idempotency_key, request_digest, user_id,
        memory_id, event_type, previous_lifecycle, resulting_lifecycle,
        content_revision, memory_governance_revision, user_catalog_generation,
        user_revocation_epoch, actor_kind, safe_reason_code
    ) VALUES (
        new_event_id, operation_id, p_idempotency_key, p_request_digest, p_user_id,
        p_memory_id, 'memory_restored', 'forgotten', 'active',
        memory.current_content_revision, next_governance_revision,
        governance.user_catalog_generation, governance.user_revocation_epoch,
        p_actor_kind, 'restored_by_user'
    );
    UPDATE public.sophia_memory_user_governance
       SET last_event_id = new_event_id, last_event_at = now()
     WHERE user_id = p_user_id;
    INSERT INTO public.sophia_memory_projection_jobs(
        user_id, memory_id, provider, environment, provider_project,
        provider_namespace, desired_content_revision, desired_governance_revision,
        operation, state, projection_operation_id
    ) VALUES (
        p_user_id, p_memory_id, p_provider, p_environment, p_provider_project,
        governance.provider_subject, memory.current_content_revision,
        next_governance_revision, 'project_revision', 'queued', operation_id
    );
    RETURN jsonb_build_object(
        'event_id', new_event_id, 'memory_id', p_memory_id,
        'content_revision', memory.current_content_revision,
        'memory_governance_revision', next_governance_revision,
        'user_catalog_generation', governance.user_catalog_generation,
        'user_revocation_epoch', governance.user_revocation_epoch,
        'idempotent_replay', false
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_claim_projection(
    p_lease_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 120
)
RETURNS TABLE(
    projection_job_id UUID,
    user_id TEXT,
    memory_id UUID,
    provider TEXT,
    environment TEXT,
    provider_project TEXT,
    provider_namespace TEXT,
    desired_content_revision BIGINT,
    desired_governance_revision BIGINT,
    operation TEXT,
    state TEXT,
    lease_token UUID,
    projection_operation_id TEXT,
    canonical_content TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
    IF p_lease_seconds < 10 OR p_lease_seconds > 600 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_lease_seconds_invalid';
    END IF;
    RETURN QUERY
    WITH chosen AS (
        SELECT job.projection_job_id
          FROM public.sophia_memory_projection_jobs job
         WHERE (
             job.state IN ('queued', 'purge_queued', 'failed_retryable', 'ambiguous')
             AND job.next_attempt_at <= now()
         ) OR (
             job.state IN ('leased', 'purging') AND job.lease_expires_at <= now()
         )
         ORDER BY job.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
    ), leased AS (
        UPDATE public.sophia_memory_projection_jobs job
           SET state = CASE WHEN job.operation = 'purge_binding' THEN 'purging' ELSE 'leased' END,
               attempt_count = job.attempt_count + 1,
               lease_owner = p_lease_owner,
               lease_token = gen_random_uuid(),
               lease_epoch = job.lease_epoch + 1,
               lease_expires_at = now() + make_interval(secs => p_lease_seconds),
               updated_at = now()
          FROM chosen
         WHERE job.projection_job_id = chosen.projection_job_id
        RETURNING job.*
    )
    SELECT leased.projection_job_id, leased.user_id, leased.memory_id,
           leased.provider, leased.environment, leased.provider_project,
           leased.provider_namespace, leased.desired_content_revision,
           leased.desired_governance_revision, leased.operation, leased.state,
           leased.lease_token, leased.projection_operation_id,
           CASE
             WHEN leased.operation = 'project_revision'
              AND memory.lifecycle = 'active'
              AND memory.current_content_revision = leased.desired_content_revision
              AND memory.memory_governance_revision = leased.desired_governance_revision
             THEN version.canonical_content
             ELSE NULL
           END
      FROM leased
      JOIN public.sophia_memories memory
        ON memory.user_id = leased.user_id AND memory.memory_id = leased.memory_id
      LEFT JOIN public.sophia_memory_versions version
        ON version.user_id = leased.user_id
       AND version.memory_id = leased.memory_id
       AND version.content_revision = leased.desired_content_revision;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_complete_projection(
    p_user_id TEXT,
    p_projection_job_id UUID,
    p_lease_token UUID,
    p_result_state TEXT,
    p_provider_ids JSONB,
    p_metadata_verified BOOLEAN,
    p_provider_result_class TEXT,
    p_provider_error_class TEXT,
    p_safe_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    job public.sophia_memory_projection_jobs;
    memory public.sophia_memories;
    provider_id JSONB;
    eligible BOOLEAN := false;
    desired_binding_state TEXT;
    final_state TEXT;
    provider_id_collision BOOLEAN := false;
BEGIN
    SELECT * INTO STRICT job FROM public.sophia_memory_projection_jobs
     WHERE user_id = p_user_id AND projection_job_id = p_projection_job_id FOR UPDATE;
    IF job.lease_token <> p_lease_token
       OR job.state NOT IN ('leased', 'purging')
       OR job.lease_expires_at <= now() THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_projection_lease_stale';
    END IF;
    IF jsonb_typeof(coalesce(p_provider_ids, '[]'::jsonb)) <> 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_provider_ids_invalid';
    END IF;
    SELECT * INTO STRICT memory FROM public.sophia_memories
     WHERE user_id = p_user_id AND memory_id = job.memory_id FOR UPDATE;

    eligible := job.operation = 'project_revision'
        AND p_result_state = 'active'
        AND p_metadata_verified
        AND memory.lifecycle = 'active'
        AND memory.current_content_revision = job.desired_content_revision
        AND memory.memory_governance_revision = job.desired_governance_revision;

    IF job.operation = 'purge_binding' THEN
        final_state := CASE WHEN p_result_state = 'purged' THEN 'purged' ELSE p_result_state END;
        IF final_state NOT IN ('purged', 'failed_retryable', 'failed_terminal', 'ambiguous') THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_projection_result_invalid';
        END IF;
        IF final_state = 'purged' THEN
            UPDATE public.sophia_memory_provider_bindings
               SET binding_state = 'purged', updated_at = now()
             WHERE user_id = p_user_id AND memory_id = job.memory_id
               AND provider = job.provider AND environment = job.environment
               AND provider_project = job.provider_project
               AND provider_namespace = job.provider_namespace;
            UPDATE public.sophia_memory_tombstones tombstone
               SET purge_status_summary = 'purge_verified'
             WHERE tombstone.user_id = p_user_id AND tombstone.memory_id = job.memory_id
               AND NOT EXISTS (
                   SELECT 1 FROM public.sophia_memory_provider_bindings binding
                    WHERE binding.user_id = p_user_id AND binding.memory_id = job.memory_id
                      AND binding.binding_state <> 'purged'
               );
        END IF;
    ELSE
        final_state := CASE
            WHEN eligible THEN 'active'
            WHEN p_result_state = 'ambiguous' THEN 'ambiguous'
            WHEN p_result_state IN ('failed_retryable', 'failed_terminal') THEN p_result_state
            ELSE 'stale'
        END;
        desired_binding_state := CASE
            WHEN eligible THEN 'eligible'
            WHEN final_state = 'ambiguous' THEN 'reconciliation_hold'
            WHEN memory.lifecycle = 'tombstoned' THEN 'orphaned'
            ELSE 'stale'
        END;
        FOR provider_id IN SELECT value FROM jsonb_array_elements(coalesce(p_provider_ids, '[]'::jsonb))
        LOOP
            IF jsonb_typeof(provider_id) <> 'string' OR length(trim(both '"' from provider_id::text)) = 0 THEN
                RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_provider_id_invalid';
            END IF;
            INSERT INTO public.sophia_memory_provider_bindings(
                user_id, memory_id, provider, environment, provider_project,
                provider_namespace, provider_memory_id, canonical_content_revision,
                memory_governance_revision, projection_operation_id, binding_state,
                metadata_verification_state, last_verified_at
            ) VALUES (
                p_user_id, job.memory_id, job.provider, job.environment,
                job.provider_project, job.provider_namespace,
                trim(both '"' from provider_id::text), job.desired_content_revision,
                job.desired_governance_revision, job.projection_operation_id,
                desired_binding_state, CASE WHEN p_metadata_verified THEN 'verified' ELSE 'failed' END,
                CASE WHEN p_metadata_verified THEN now() ELSE NULL END
            )
            ON CONFLICT (
                user_id, memory_id, provider, environment, provider_project,
                provider_namespace, provider_memory_id
            ) DO UPDATE SET
                canonical_content_revision = EXCLUDED.canonical_content_revision,
                memory_governance_revision = EXCLUDED.memory_governance_revision,
                projection_operation_id = EXCLUDED.projection_operation_id,
                binding_state = EXCLUDED.binding_state,
                metadata_verification_state = EXCLUDED.metadata_verification_state,
                last_verified_at = EXCLUDED.last_verified_at,
                updated_at = now();
        END LOOP;
        SELECT EXISTS (
            SELECT 1
              FROM public.sophia_memory_provider_bindings left_binding
              JOIN public.sophia_memory_provider_bindings right_binding
                ON right_binding.user_id = left_binding.user_id
               AND right_binding.provider = left_binding.provider
               AND right_binding.environment = left_binding.environment
               AND right_binding.provider_project = left_binding.provider_project
               AND right_binding.provider_namespace = left_binding.provider_namespace
               AND right_binding.provider_memory_id = left_binding.provider_memory_id
               AND right_binding.memory_id <> left_binding.memory_id
             WHERE left_binding.user_id = p_user_id
               AND left_binding.provider = job.provider
               AND left_binding.environment = job.environment
               AND left_binding.provider_project = job.provider_project
               AND left_binding.provider_namespace = job.provider_namespace
               AND left_binding.projection_operation_id = job.projection_operation_id
        ) INTO provider_id_collision;
        IF provider_id_collision THEN
            UPDATE public.sophia_memory_provider_bindings binding
               SET binding_state = 'reconciliation_hold',
                   metadata_verification_state = 'conflict',
                   updated_at = now()
             WHERE binding.user_id = p_user_id
               AND binding.provider = job.provider
               AND binding.environment = job.environment
               AND binding.provider_project = job.provider_project
               AND binding.provider_namespace = job.provider_namespace
               AND EXISTS (
                   SELECT 1
                     FROM public.sophia_memory_provider_bindings collision
                    WHERE collision.user_id = binding.user_id
                      AND collision.provider = binding.provider
                      AND collision.environment = binding.environment
                      AND collision.provider_project = binding.provider_project
                      AND collision.provider_namespace = binding.provider_namespace
                      AND collision.provider_memory_id = binding.provider_memory_id
                      AND collision.memory_id <> binding.memory_id
               );
            eligible := false;
            final_state := 'orphaned';
        END IF;
        IF eligible THEN
            UPDATE public.sophia_memory_provider_bindings binding
               SET binding_state = 'stale', updated_at = now()
             WHERE binding.user_id = p_user_id AND binding.memory_id = job.memory_id
               AND binding.provider = job.provider AND binding.environment = job.environment
               AND binding.provider_project = job.provider_project
               AND binding.provider_namespace = job.provider_namespace
               AND binding.projection_operation_id <> job.projection_operation_id
               AND binding.binding_state <> 'purged';
        ELSIF EXISTS (
            SELECT 1 FROM public.sophia_memory_provider_bindings binding
             WHERE binding.user_id = p_user_id AND binding.memory_id = job.memory_id
               AND binding.projection_operation_id = job.projection_operation_id
               AND binding.binding_state IN ('stale', 'orphaned')
        ) THEN
            INSERT INTO public.sophia_memory_projection_jobs(
                user_id, memory_id, provider, environment, provider_project,
                provider_namespace, desired_content_revision, desired_governance_revision,
                operation, state, projection_operation_id
            ) VALUES (
                p_user_id, job.memory_id, job.provider, job.environment,
                job.provider_project, job.provider_namespace,
                job.desired_content_revision, job.desired_governance_revision,
                'purge_binding', 'purge_queued',
                job.projection_operation_id || '-purge'
            ) ON CONFLICT DO NOTHING;
        END IF;
    END IF;

    UPDATE public.sophia_memory_projection_jobs
       SET state = final_state,
           provider_result_class = p_provider_result_class,
           provider_error_class = p_provider_error_class,
           safe_reason_code = p_safe_reason_code,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = CASE
               WHEN final_state IN ('failed_retryable', 'ambiguous')
               THEN now() + make_interval(secs => LEAST(900, 5 * (2 ^ LEAST(attempt_count, 7))::integer))
               ELSE next_attempt_at
           END,
           completed_at = CASE WHEN final_state IN ('active', 'purged', 'stale', 'failed_terminal') THEN now() ELSE NULL END,
           updated_at = now()
     WHERE projection_job_id = p_projection_job_id;
    RETURN jsonb_build_object(
        'projection_job_id', p_projection_job_id,
        'state', final_state,
        'eligible', eligible,
        'provider_id_count', jsonb_array_length(coalesce(p_provider_ids, '[]'::jsonb)),
        'safe_reason_code', p_safe_reason_code
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_fail_extraction(
    p_user_id TEXT,
    p_extraction_run_id UUID,
    p_lease_token UUID,
    p_error_code TEXT,
    p_retryable BOOLEAN
)
RETURNS public.sophia_memory_extraction_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    run public.sophia_memory_extraction_runs;
BEGIN
    SELECT * INTO STRICT run FROM public.sophia_memory_extraction_runs
     WHERE user_id = p_user_id AND extraction_run_id = p_extraction_run_id FOR UPDATE;
    IF run.state <> 'leased' OR run.lease_token <> p_lease_token OR run.lease_expires_at <= now() THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'memory_extraction_lease_stale';
    END IF;
    UPDATE public.sophia_memory_extraction_runs
       SET state = CASE WHEN p_retryable AND attempt_count < 8 THEN 'retry_wait' ELSE 'failed_terminal' END,
           next_attempt_at = CASE
               WHEN p_retryable AND attempt_count < 8
               THEN now() + make_interval(secs => LEAST(900, 5 * (2 ^ LEAST(attempt_count, 7))::integer))
               ELSE next_attempt_at
           END,
           error_code = nullif(p_error_code, ''),
           safe_terminal_reason = CASE
               WHEN p_retryable AND attempt_count < 8 THEN 'retry_scheduled'
               ELSE 'retry_budget_exhausted'
           END,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           terminal_at = CASE WHEN p_retryable AND attempt_count < 8 THEN NULL ELSE now() END,
           updated_at = now()
     WHERE extraction_run_id = p_extraction_run_id
     RETURNING * INTO run;
    RETURN run;
END
$function$;

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
        latency_segments
    ) VALUES (
        admission_id, p_retrieval_request_id, p_user_id, p_caller, p_scope,
        p_query_ref, p_provider_status, p_provider_hit_count,
        p_catalog_generation_checked, p_revocation_epoch_checked,
        p_authorized_manifest, coalesce(p_denial_counts, '{}'::jsonb),
        p_outcome, p_safe_reason_code, coalesce(p_latency_segments, '{}'::jsonb)
    );
    RETURN admission_id;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_expire_candidates(
    p_limit INTEGER DEFAULT 500
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    affected INTEGER;
BEGIN
    IF p_limit < 1 OR p_limit > 5000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_expiry_limit_invalid';
    END IF;
    WITH expired AS (
        SELECT candidate.user_id, candidate.candidate_id
          FROM public.sophia_memory_candidates candidate
         WHERE candidate.review_state = 'pending_review'
           AND candidate.created_at <= now() - interval '30 days'
         ORDER BY candidate.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
    ), scrubbed_versions AS (
        UPDATE public.sophia_memory_candidate_versions version
           SET proposed_content = NULL, content_ref = NULL, scrubbed_at = now()
          FROM expired
         WHERE version.user_id = expired.user_id
           AND version.candidate_id = expired.candidate_id
        RETURNING version.user_id, version.candidate_id
    )
    UPDATE public.sophia_memory_candidates candidate
       SET review_state = 'expired', expired_at = now(), scrubbed_at = now()
      FROM expired
     WHERE candidate.user_id = expired.user_id
       AND candidate.candidate_id = expired.candidate_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_arm_fault(
    p_user_id TEXT,
    p_mode TEXT,
    p_ttl_seconds INTEGER,
    p_audit_ref TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    setting public.sophia_memory_fault_settings;
BEGIN
    IF p_user_id IS NULL OR length(btrim(p_user_id)) = 0
       OR p_ttl_seconds < 1 OR p_ttl_seconds > 300
       OR p_audit_ref NOT LIKE 'hmac-sha256:%' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'memory_fault_setting_invalid';
    END IF;
    INSERT INTO public.sophia_memory_fault_settings(
        user_id, mode, remaining_uses, expires_at, audit_ref
    ) VALUES (
        p_user_id, p_mode, 1, now() + make_interval(secs => p_ttl_seconds), p_audit_ref
    )
    ON CONFLICT (user_id, mode) DO UPDATE
       SET fault_setting_id = gen_random_uuid(), remaining_uses = 1,
           expires_at = excluded.expires_at, audit_ref = excluded.audit_ref,
           created_at = now(), consumed_at = NULL, cleared_at = NULL
    RETURNING * INTO setting;
    RETURN jsonb_build_object(
        'fault_setting_id', setting.fault_setting_id,
        'mode', setting.mode,
        'remaining_uses', setting.remaining_uses,
        'expires_at', setting.expires_at,
        'audit_ref', setting.audit_ref
    );
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_consume_fault(
    p_user_id TEXT,
    p_mode TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    consumed BOOLEAN := false;
BEGIN
    UPDATE public.sophia_memory_fault_settings
       SET remaining_uses = 0, consumed_at = now()
     WHERE user_id = p_user_id
       AND mode = p_mode
       AND remaining_uses = 1
       AND cleared_at IS NULL
       AND expires_at > now();
    consumed := FOUND;
    RETURN consumed;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_clear_faults(p_user_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    affected INTEGER;
BEGIN
    UPDATE public.sophia_memory_fault_settings
       SET remaining_uses = 0, cleared_at = coalesce(cleared_at, now())
     WHERE user_id = p_user_id AND cleared_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END
$function$;

CREATE OR REPLACE FUNCTION public.sophia_memory_expire_projection_lease(
    p_user_id TEXT,
    p_projection_job_id UUID,
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    affected BOOLEAN := false;
BEGIN
    UPDATE public.sophia_memory_projection_jobs
       SET lease_expires_at = now() - interval '1 second', updated_at = now()
     WHERE user_id = p_user_id
       AND projection_job_id = p_projection_job_id
       AND lease_token = p_lease_token
       AND state IN ('leased', 'purging');
    affected := FOUND;
    RETURN affected;
END
$function$;

REVOKE ALL ON FUNCTION public.sophia_memory_ensure_governance(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_invalidate_source(TEXT,TEXT,BIGINT,BOOLEAN,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_enqueue_extraction(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_finalize_and_enqueue_extraction(TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_claim_extraction(TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_complete_extraction(TEXT,UUID,UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_approve_candidate(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_tombstone(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_reject_candidate(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_manual_create(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_edit(TEXT,UUID,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_forget(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_restore(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_claim_projection(TEXT,INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_complete_projection(TEXT,UUID,UUID,TEXT,JSONB,BOOLEAN,TEXT,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_fail_extraction(TEXT,UUID,UUID,TEXT,BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_record_prompt_admission(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BIGINT,BIGINT,JSONB,JSONB,TEXT,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_expire_candidates(INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_arm_fault(TEXT,TEXT,INTEGER,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_consume_fault(TEXT,TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_clear_faults(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sophia_memory_expire_projection_lease(TEXT,UUID,UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_memory_ensure_governance(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_invalidate_source(TEXT,TEXT,BIGINT,BOOLEAN,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_enqueue_extraction(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_finalize_and_enqueue_extraction(TEXT,TEXT,TEXT,TIMESTAMPTZ,TEXT,TEXT,TEXT,BIGINT,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_claim_extraction(TEXT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_complete_extraction(TEXT,UUID,UUID,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_approve_candidate(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_tombstone(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_reject_candidate(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_manual_create(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_edit(TEXT,UUID,BIGINT,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_forget(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_restore(TEXT,UUID,BIGINT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_claim_projection(TEXT,INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_complete_projection(TEXT,UUID,UUID,TEXT,JSONB,BOOLEAN,TEXT,TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_fail_extraction(TEXT,UUID,UUID,TEXT,BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_record_prompt_admission(UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,INTEGER,BIGINT,BIGINT,JSONB,JSONB,TEXT,TEXT,JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_expire_candidates(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_arm_fault(TEXT,TEXT,INTEGER,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_consume_fault(TEXT,TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_clear_faults(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_memory_expire_projection_lease(TEXT,UUID,UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
