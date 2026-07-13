-- Sophia P-2 build foundation.
-- Object bodies remain in the internal .builder/builds namespace. These
-- tables own concurrency, lookup projection, event idempotency, and outbox.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sophia_build_manifest_heads (
    build_id                    TEXT PRIMARY KEY,
    user_id                     TEXT NOT NULL,
    owner_thread_id             TEXT NOT NULL,
    manifest_revision           BIGINT NOT NULL CHECK (manifest_revision >= 1),
    manifest_object_path        TEXT NOT NULL CHECK (manifest_object_path LIKE '%.builder/builds/%'),
    manifest_hash               TEXT NOT NULL,
    logical_artifact_id         TEXT,
    current_artifact_version_id TEXT,
    status                      TEXT NOT NULL,
    format                      TEXT NOT NULL,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sophia_build_heads_user_build_idx
    ON public.sophia_build_manifest_heads (user_id, build_id);

CREATE TABLE IF NOT EXISTS public.sophia_build_registry (
    user_id                     TEXT NOT NULL,
    build_id                    TEXT NOT NULL,
    owner_thread_id             TEXT NOT NULL,
    logical_artifact_id         TEXT,
    current_artifact_version_id TEXT,
    manifest_object_path        TEXT NOT NULL CHECK (manifest_object_path LIKE '%.builder/builds/%'),
    current_manifest_revision   BIGINT NOT NULL CHECK (current_manifest_revision >= 1),
    status                      TEXT NOT NULL,
    format                      TEXT NOT NULL,
    project_id                  TEXT,
    registry_sync_pending       BOOLEAN NOT NULL DEFAULT false,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, build_id),
    FOREIGN KEY (build_id) REFERENCES public.sophia_build_manifest_heads(build_id)
);

CREATE INDEX IF NOT EXISTS sophia_build_registry_user_updated_idx
    ON public.sophia_build_registry (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.sophia_build_operation_events (
    build_id      TEXT NOT NULL,
    event_id      TEXT NOT NULL,
    sequence      BIGINT NOT NULL CHECK (sequence >= 1),
    user_id       TEXT NOT NULL,
    event_type    TEXT NOT NULL,
    occurred_at   TIMESTAMPTZ NOT NULL,
    event_payload JSONB NOT NULL,
    PRIMARY KEY (build_id, event_id),
    UNIQUE (build_id, sequence)
);

CREATE TABLE IF NOT EXISTS public.sophia_build_acceptance_outbox (
    idempotency_key             TEXT PRIMARY KEY,
    build_id                    TEXT NOT NULL,
    user_id                     TEXT NOT NULL,
    logical_artifact_id         TEXT NOT NULL,
    artifact_version_id         TEXT NOT NULL,
    manifest_revision           BIGINT NOT NULL,
    payload                     JSONB NOT NULL,
    delivery_status             TEXT NOT NULL DEFAULT 'pending'
                                CHECK (delivery_status IN ('pending', 'delivering', 'delivered', 'failed')),
    delivery_attempts           INTEGER NOT NULL DEFAULT 0,
    next_attempt_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    delivered_at                TIMESTAMPTZ,
    UNIQUE (logical_artifact_id, artifact_version_id, manifest_revision)
);

CREATE TABLE IF NOT EXISTS public.sophia_build_mutation_transactions (
    transaction_id             TEXT PRIMARY KEY,
    build_id                    TEXT NOT NULL,
    user_id                     TEXT NOT NULL,
    operation_id                TEXT NOT NULL,
    expected_manifest_revision  BIGINT NOT NULL,
    status                      TEXT NOT NULL,
    lease_owner                 TEXT NOT NULL,
    lease_expires_at            TIMESTAMPTZ NOT NULL,
    transaction_payload         JSONB NOT NULL,
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sophia_build_mutation_active_idx
    ON public.sophia_build_mutation_transactions (build_id, lease_expires_at)
    WHERE status NOT IN ('committed', 'rolled_back', 'failed');

CREATE OR REPLACE FUNCTION public.sophia_commit_build_manifest(
    p_build_id TEXT,
    p_user_id TEXT,
    p_owner_thread_id TEXT,
    p_expected_revision BIGINT,
    p_manifest_object_path TEXT,
    p_manifest_hash TEXT,
    p_logical_artifact_id TEXT,
    p_artifact_version_id TEXT,
    p_status TEXT,
    p_format TEXT,
    p_project_id TEXT,
    p_acceptance_payload JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_current_revision BIGINT;
    v_new_revision BIGINT;
    v_idempotency_key TEXT;
BEGIN
    IF p_user_id IS NULL OR btrim(p_user_id) = '' OR p_owner_thread_id IS NULL OR btrim(p_owner_thread_id) = '' THEN
        RAISE EXCEPTION 'build owner identity is required' USING ERRCODE = '22023';
    END IF;
    IF p_manifest_object_path NOT LIKE '%.builder/builds/%' THEN
        RAISE EXCEPTION 'manifest path must use internal build namespace' USING ERRCODE = '22023';
    END IF;

    SELECT manifest_revision INTO v_current_revision
      FROM public.sophia_build_manifest_heads
     WHERE build_id = p_build_id AND user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        IF p_expected_revision <> 0 THEN
            RAISE EXCEPTION 'build_manifest_concurrent_modification' USING ERRCODE = '40001';
        END IF;
        v_new_revision := 1;
        INSERT INTO public.sophia_build_manifest_heads (
            build_id, user_id, owner_thread_id, manifest_revision,
            manifest_object_path, manifest_hash, logical_artifact_id,
            current_artifact_version_id, status, format
        ) VALUES (
            p_build_id, p_user_id, p_owner_thread_id, v_new_revision,
            p_manifest_object_path, p_manifest_hash, p_logical_artifact_id,
            p_artifact_version_id, p_status, p_format
        );
    ELSE
        IF v_current_revision <> p_expected_revision THEN
            RAISE EXCEPTION 'build_manifest_concurrent_modification' USING ERRCODE = '40001';
        END IF;
        v_new_revision := v_current_revision + 1;
        UPDATE public.sophia_build_manifest_heads
           SET owner_thread_id = p_owner_thread_id,
               manifest_revision = v_new_revision,
               manifest_object_path = p_manifest_object_path,
               manifest_hash = p_manifest_hash,
               logical_artifact_id = COALESCE(logical_artifact_id, p_logical_artifact_id),
               current_artifact_version_id = p_artifact_version_id,
               status = p_status,
               format = p_format,
               updated_at = now()
         WHERE build_id = p_build_id AND user_id = p_user_id;
    END IF;

    INSERT INTO public.sophia_build_registry (
        user_id, build_id, owner_thread_id, logical_artifact_id,
        current_artifact_version_id, manifest_object_path,
        current_manifest_revision, status, format, project_id,
        registry_sync_pending, updated_at
    ) VALUES (
        p_user_id, p_build_id, p_owner_thread_id, p_logical_artifact_id,
        p_artifact_version_id, p_manifest_object_path,
        v_new_revision, p_status, p_format, p_project_id, false, now()
    ) ON CONFLICT (user_id, build_id) DO UPDATE SET
        owner_thread_id = EXCLUDED.owner_thread_id,
        logical_artifact_id = COALESCE(sophia_build_registry.logical_artifact_id, EXCLUDED.logical_artifact_id),
        current_artifact_version_id = EXCLUDED.current_artifact_version_id,
        manifest_object_path = EXCLUDED.manifest_object_path,
        current_manifest_revision = EXCLUDED.current_manifest_revision,
        status = EXCLUDED.status,
        format = EXCLUDED.format,
        project_id = COALESCE(EXCLUDED.project_id, sophia_build_registry.project_id),
        registry_sync_pending = false,
        updated_at = now();

    IF p_acceptance_payload IS NOT NULL THEN
        IF p_logical_artifact_id IS NULL OR p_artifact_version_id IS NULL THEN
            RAISE EXCEPTION 'accepted artifact IDs are required' USING ERRCODE = '22023';
        END IF;
        v_idempotency_key := p_logical_artifact_id || ':' || p_artifact_version_id || ':' || v_new_revision::TEXT;
        INSERT INTO public.sophia_build_acceptance_outbox (
            idempotency_key, build_id, user_id, logical_artifact_id,
            artifact_version_id, manifest_revision, payload
        ) VALUES (
            v_idempotency_key, p_build_id, p_user_id, p_logical_artifact_id,
            p_artifact_version_id, v_new_revision, p_acceptance_payload
        ) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;

    RETURN v_new_revision;
END;
$$;

REVOKE ALL ON FUNCTION public.sophia_commit_build_manifest(
    TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_commit_build_manifest(
    TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.sophia_append_build_event(
    p_build_id TEXT,
    p_event_id TEXT,
    p_user_id TEXT,
    p_event_type TEXT,
    p_occurred_at TIMESTAMPTZ,
    p_event_payload JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sequence BIGINT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext(p_build_id));
    SELECT COALESCE(MAX(sequence), 0) + 1 INTO v_sequence
      FROM public.sophia_build_operation_events
     WHERE build_id = p_build_id;
    INSERT INTO public.sophia_build_operation_events (
        build_id, event_id, sequence, user_id, event_type, occurred_at, event_payload
    ) VALUES (
        p_build_id, p_event_id, v_sequence, p_user_id, p_event_type, p_occurred_at,
        jsonb_set(p_event_payload, '{sequence}', to_jsonb(v_sequence), true)
    ) ON CONFLICT (build_id, event_id) DO UPDATE
        SET event_id = EXCLUDED.event_id
    RETURNING sequence INTO v_sequence;
    RETURN v_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.sophia_append_build_event(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sophia_append_build_event(TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, JSONB)
    TO service_role;

REVOKE ALL ON TABLE public.sophia_build_manifest_heads FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sophia_build_registry FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sophia_build_operation_events FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sophia_build_acceptance_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sophia_build_mutation_transactions FROM PUBLIC, anon, authenticated, service_role;

-- Event replay and readiness use a direct PostgREST SELECT. All writes and
-- manifest mutations remain behind the SECURITY DEFINER RPCs above.
GRANT SELECT ON TABLE public.sophia_build_operation_events TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
