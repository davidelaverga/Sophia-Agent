-- DQ-2 durable exact-canary mutation transaction substrate.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sophia_build_mutation_transactions (
    transaction_id              TEXT PRIMARY KEY,
    build_id                     TEXT NOT NULL,
    user_id                      TEXT NOT NULL,
    operation_id                 TEXT NOT NULL,
    expected_manifest_revision   BIGINT NOT NULL,
    status                       TEXT NOT NULL,
    lease_owner                  TEXT NOT NULL,
    lease_expires_at             TIMESTAMPTZ NOT NULL,
    transaction_payload          JSONB NOT NULL,
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sophia_build_mutation_transactions
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

LOCK TABLE public.sophia_build_mutation_transactions
    IN SHARE ROW EXCLUSIVE MODE;

DO $legacy_guard$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.sophia_build_mutation_transactions AS transaction
         WHERE btrim(transaction.transaction_id) = ''
            OR btrim(transaction.build_id) = ''
            OR btrim(transaction.user_id) = ''
            OR btrim(transaction.operation_id) = ''
            OR btrim(transaction.lease_owner) = ''
            OR transaction.expected_manifest_revision < 0
            OR transaction.status NOT IN (
                'prepared', 'staged', 'verified', 'committing', 'committed',
                'rolling_back', 'rolled_back', 'failed'
            )
            OR jsonb_typeof(transaction.transaction_payload) <> 'object'
            OR transaction.transaction_payload ->> 'schema_version'
                IS DISTINCT FROM 'sophia-build-transaction/v1'
            OR transaction.transaction_payload ->> 'transaction_id'
                IS DISTINCT FROM transaction.transaction_id
            OR transaction.transaction_payload ->> 'build_id'
                IS DISTINCT FROM transaction.build_id
            OR transaction.transaction_payload ->> 'user_id'
                IS DISTINCT FROM transaction.user_id
            OR transaction.transaction_payload ->> 'operation_id'
                IS DISTINCT FROM transaction.operation_id
            OR transaction.transaction_payload ->> 'expected_manifest_revision'
                IS DISTINCT FROM transaction.expected_manifest_revision::TEXT
            OR transaction.transaction_payload ->> 'status'
                IS DISTINCT FROM transaction.status
            OR transaction.transaction_payload ->> 'lease_owner'
                IS DISTINCT FROM transaction.lease_owner
    ) THEN
        RAISE EXCEPTION 'build_mutation_legacy_row_invalid'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.sophia_build_mutation_transactions
         GROUP BY user_id, build_id, operation_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'build_mutation_operation_id_conflict'
            USING ERRCODE = '23505';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policy
         WHERE polrelid = 'public.sophia_build_mutation_transactions'::REGCLASS
    ) THEN
        RAISE EXCEPTION 'build_mutation_unexpected_rls_policy'
            USING ERRCODE = '42501';
    END IF;
END;
$legacy_guard$;

DO $constraints$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.sophia_build_mutation_transactions'::REGCLASS
           AND conname = 'sophia_build_mutation_identity_shape'
    ) THEN
        ALTER TABLE public.sophia_build_mutation_transactions
            ADD CONSTRAINT sophia_build_mutation_identity_shape CHECK (
                char_length(btrim(transaction_id)) BETWEEN 1 AND 256
                AND char_length(btrim(build_id)) BETWEEN 1 AND 512
                AND char_length(btrim(user_id)) BETWEEN 1 AND 256
                AND char_length(btrim(operation_id)) BETWEEN 1 AND 256
                AND char_length(btrim(lease_owner)) BETWEEN 1 AND 256
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.sophia_build_mutation_transactions'::REGCLASS
           AND conname = 'sophia_build_mutation_revision_shape'
    ) THEN
        ALTER TABLE public.sophia_build_mutation_transactions
            ADD CONSTRAINT sophia_build_mutation_revision_shape
            CHECK (expected_manifest_revision >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.sophia_build_mutation_transactions'::REGCLASS
           AND conname = 'sophia_build_mutation_status_shape'
    ) THEN
        ALTER TABLE public.sophia_build_mutation_transactions
            ADD CONSTRAINT sophia_build_mutation_status_shape CHECK (
                status IN (
                    'prepared', 'staged', 'verified', 'committing', 'committed',
                    'rolling_back', 'rolled_back', 'failed'
                )
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.sophia_build_mutation_transactions'::REGCLASS
           AND conname = 'sophia_build_mutation_payload_shape'
    ) THEN
        ALTER TABLE public.sophia_build_mutation_transactions
            ADD CONSTRAINT sophia_build_mutation_payload_shape
            CHECK (jsonb_typeof(transaction_payload) = 'object');
    END IF;
END;
$constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS sophia_build_mutation_operation_idx
    ON public.sophia_build_mutation_transactions (user_id, build_id, operation_id);

CREATE INDEX IF NOT EXISTS sophia_build_mutation_active_idx
    ON public.sophia_build_mutation_transactions (build_id, lease_expires_at)
    WHERE status NOT IN ('committed', 'rolled_back', 'failed');

CREATE INDEX IF NOT EXISTS sophia_build_mutation_recovery_idx
    ON public.sophia_build_mutation_transactions (
        user_id, build_id, lease_expires_at, updated_at, transaction_id
    )
    WHERE status NOT IN ('committed', 'rolled_back', 'failed');

ALTER TABLE public.sophia_build_mutation_transactions
    OWNER TO postgres;
ALTER TABLE public.sophia_build_mutation_transactions
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sophia_build_mutation_transactions
    FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sophia_build_mutation_transactions FROM PUBLIC;
REVOKE ALL ON TABLE public.sophia_build_manifest_heads FROM PUBLIC;
REVOKE ALL ON TABLE public.sophia_build_registry FROM PUBLIC;
REVOKE ALL ON TABLE public.sophia_build_acceptance_outbox FROM PUBLIC;

DO $table_acl_convergence$
DECLARE
    v_principal RECORD;
    v_relation RECORD;
BEGIN
    FOR v_relation IN
        SELECT relation.oid::REGCLASS AS identity
          FROM pg_catalog.pg_class AS relation
         WHERE relation.oid IN (
             'public.sophia_build_mutation_transactions'::REGCLASS,
             'public.sophia_build_manifest_heads'::REGCLASS,
             'public.sophia_build_registry'::REGCLASS,
             'public.sophia_build_acceptance_outbox'::REGCLASS
         )
    LOOP
        FOR v_principal IN
            SELECT role.rolname
              FROM pg_catalog.pg_roles AS role
             WHERE role.oid <> 'postgres'::REGROLE
        LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
                v_relation.identity,
                v_principal.rolname
            );
        END LOOP;
    END LOOP;
END;
$table_acl_convergence$;

CREATE OR REPLACE FUNCTION public.sophia_create_build_mutation_transaction(
    p_user_id TEXT,
    p_transaction_payload JSONB
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_transaction_id TEXT;
    v_build_id TEXT;
    v_operation_id TEXT;
    v_expected_manifest_revision BIGINT;
    v_lease_owner TEXT;
    v_lease_expires_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ;
    v_role RECORD;
    v_transaction public.sophia_build_mutation_transactions%ROWTYPE;
BEGIN
    v_now := clock_timestamp();
    IF p_user_id IS NULL OR btrim(p_user_id) = ''
       OR char_length(p_user_id) > 256 THEN
        RAISE EXCEPTION 'build_mutation_user_invalid'
            USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(p_transaction_payload) <> 'object'
       OR p_transaction_payload ->> 'schema_version'
            IS DISTINCT FROM 'sophia-build-transaction/v1'
       OR p_transaction_payload ->> 'user_id' IS DISTINCT FROM p_user_id
       OR p_transaction_payload ->> 'status' IS DISTINCT FROM 'prepared'
       OR jsonb_typeof(p_transaction_payload -> 'expected_manifest_revision')
            <> 'number'
       OR jsonb_typeof(p_transaction_payload -> 'lease_expires_at') <> 'string' THEN
        RAISE EXCEPTION 'build_mutation_payload_invalid'
            USING ERRCODE = '22023';
    END IF;

    BEGIN
        v_transaction_id := p_transaction_payload ->> 'transaction_id';
        v_build_id := p_transaction_payload ->> 'build_id';
        v_operation_id := p_transaction_payload ->> 'operation_id';
        v_expected_manifest_revision :=
            (p_transaction_payload ->> 'expected_manifest_revision')::BIGINT;
        v_lease_owner := p_transaction_payload ->> 'lease_owner';
        v_lease_expires_at :=
            (p_transaction_payload ->> 'lease_expires_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'build_mutation_payload_invalid'
            USING ERRCODE = '22023';
    END;

    IF v_transaction_id IS NULL OR btrim(v_transaction_id) = ''
       OR char_length(v_transaction_id) > 256
       OR v_build_id IS NULL OR btrim(v_build_id) = ''
       OR char_length(v_build_id) > 512
       OR v_operation_id IS NULL OR btrim(v_operation_id) = ''
       OR char_length(v_operation_id) > 256
       OR v_expected_manifest_revision < 0
       OR v_lease_owner IS NULL OR btrim(v_lease_owner) = ''
       OR char_length(v_lease_owner) > 256 THEN
        RAISE EXCEPTION 'build_mutation_identity_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF NULLIF(btrim(p_transaction_payload ->> 'campaign_run_id'), '') IS NULL
       OR char_length(p_transaction_payload ->> 'campaign_run_id') > 512
       OR COALESCE(p_transaction_payload ->> 'owner_thread_id', '')
            !~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$'
       OR NULLIF(btrim(p_transaction_payload ->> 'initial_quality_run_id'), '') IS NULL
       OR char_length(p_transaction_payload ->> 'initial_quality_run_id') > 512
       OR COALESCE(p_transaction_payload ->> 'repair_program_hash', '')
            !~ '^[0-9a-f]{64}$'
       OR NULLIF(
            btrim(p_transaction_payload ->> 'expected_artifact_version_id'), ''
          ) IS NULL
       OR char_length(p_transaction_payload ->> 'expected_artifact_version_id') > 512
       OR COALESCE(p_transaction_payload ->> 'expected_artifact_hash', '')
            !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(p_transaction_payload -> 'expected_component_versions')
            <> 'object'
       OR p_transaction_payload -> 'expected_component_versions' = '{}'::JSONB
       OR jsonb_typeof(p_transaction_payload -> 'authorized_selectors') <> 'array'
       OR jsonb_array_length(p_transaction_payload -> 'authorized_selectors') = 0
       OR jsonb_typeof(p_transaction_payload -> 'authorized_source_roles')
            <> 'object'
       OR p_transaction_payload -> 'authorized_source_roles' = '{}'::JSONB
       OR jsonb_typeof(p_transaction_payload -> 'staged_object_paths') <> 'array'
       OR jsonb_array_length(p_transaction_payload -> 'staged_object_paths') <> 0
       OR jsonb_typeof(p_transaction_payload -> 'candidate_version_ids') <> 'array'
       OR jsonb_array_length(p_transaction_payload -> 'candidate_version_ids') <> 0
       OR p_transaction_payload ->> 'candidate_manifest_object_path' IS NOT NULL
       OR p_transaction_payload ->> 'candidate_manifest_hash' IS NOT NULL
       OR p_transaction_payload ->> 'candidate_artifact_version_id' IS NOT NULL
       OR p_transaction_payload ->> 'candidate_artifact_hash' IS NOT NULL
       OR p_transaction_payload ->> 'candidate_quality_run_id' IS NOT NULL
       OR p_transaction_payload ->> 'comparison_hash' IS NOT NULL
       OR jsonb_typeof(p_transaction_payload -> 'gate_evidence') <> 'object'
       OR p_transaction_payload -> 'gate_evidence' = '{}'::JSONB THEN
        RAISE EXCEPTION 'build_mutation_dq2_evidence_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(
              p_transaction_payload -> 'authorized_selectors'
          ) AS selector(value)
         WHERE jsonb_typeof(selector.value) <> 'string'
            OR NULLIF(btrim(selector.value #>> '{}'), '') IS NULL
            OR char_length(selector.value #>> '{}') > 512
    ) OR (
        SELECT count(*) <> count(DISTINCT selector.value #>> '{}')
          FROM jsonb_array_elements(
              p_transaction_payload -> 'authorized_selectors'
          ) AS selector(value)
    ) OR (
        SELECT count(*)
          FROM jsonb_object_keys(
              p_transaction_payload -> 'authorized_source_roles'
          ) AS source_role(selector)
    ) <> jsonb_array_length(p_transaction_payload -> 'authorized_selectors')
    OR EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
              p_transaction_payload -> 'authorized_selectors'
          ) AS selector(value)
         WHERE NOT (
             p_transaction_payload -> 'authorized_source_roles' ? selector.value
         )
    ) THEN
        RAISE EXCEPTION 'build_mutation_selector_identity_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements_text(
              p_transaction_payload -> 'authorized_selectors'
          ) AS selector(value)
         WHERE NOT (
             p_transaction_payload -> 'expected_component_versions' ? selector.value
         )
    ) THEN
        RAISE EXCEPTION 'build_mutation_selector_component_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_each(
              p_transaction_payload -> 'expected_component_versions'
          ) AS component(selector, version)
         WHERE NULLIF(btrim(component.selector), '') IS NULL
            OR char_length(component.selector) > 512
            OR jsonb_typeof(component.version) <> 'string'
            OR NULLIF(btrim(component.version #>> '{}'), '') IS NULL
            OR char_length(component.version #>> '{}') > 512
    ) THEN
        RAISE EXCEPTION 'build_mutation_component_identity_invalid'
            USING ERRCODE = '22023';
    END IF;

    FOR v_role IN
        SELECT role.key AS selector, role.value AS roles
          FROM jsonb_each(
              p_transaction_payload -> 'authorized_source_roles'
          ) AS role
    LOOP
        IF btrim(v_role.selector) = ''
           OR jsonb_typeof(v_role.roles) <> 'array'
           OR jsonb_array_length(v_role.roles) = 0 THEN
            RAISE EXCEPTION 'build_mutation_source_role_invalid'
                USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1
              FROM jsonb_array_elements(v_role.roles) AS source_role(value)
             WHERE jsonb_typeof(source_role.value) <> 'string'
                OR NULLIF(btrim(source_role.value #>> '{}'), '') IS NULL
                OR char_length(source_role.value #>> '{}') > 256
        ) THEN
            RAISE EXCEPTION 'build_mutation_source_role_invalid'
                USING ERRCODE = '22023';
        END IF;
        IF (
            SELECT count(*) <> count(DISTINCT source_role.value #>> '{}')
              FROM jsonb_array_elements(v_role.roles) AS source_role(value)
        ) THEN
            RAISE EXCEPTION 'build_mutation_source_role_invalid'
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    PERFORM pg_advisory_xact_lock(
        hashtext(p_user_id || chr(31) || v_build_id || chr(31) || v_operation_id)
    );

    SELECT transaction.*
      INTO v_transaction
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.user_id = p_user_id
       AND transaction.build_id = v_build_id
       AND transaction.operation_id = v_operation_id
     FOR UPDATE;

    IF FOUND THEN
        IF v_transaction.expected_manifest_revision
                IS DISTINCT FROM v_expected_manifest_revision
           OR v_transaction.transaction_payload -> 'campaign_run_id'
                IS DISTINCT FROM p_transaction_payload -> 'campaign_run_id'
           OR v_transaction.transaction_payload -> 'owner_thread_id'
                IS DISTINCT FROM p_transaction_payload -> 'owner_thread_id'
           OR v_transaction.transaction_payload -> 'authorized_selectors'
                IS DISTINCT FROM p_transaction_payload -> 'authorized_selectors'
           OR v_transaction.transaction_payload -> 'authorized_source_roles'
                IS DISTINCT FROM p_transaction_payload -> 'authorized_source_roles'
           OR v_transaction.transaction_payload -> 'repair_program_hash'
                IS DISTINCT FROM p_transaction_payload -> 'repair_program_hash'
           OR v_transaction.transaction_payload -> 'initial_quality_run_id'
                IS DISTINCT FROM p_transaction_payload -> 'initial_quality_run_id'
           OR v_transaction.transaction_payload -> 'expected_artifact_version_id'
                IS DISTINCT FROM
                    p_transaction_payload -> 'expected_artifact_version_id'
           OR v_transaction.transaction_payload -> 'expected_artifact_hash'
                IS DISTINCT FROM p_transaction_payload -> 'expected_artifact_hash'
           OR v_transaction.transaction_payload -> 'expected_component_versions'
                IS DISTINCT FROM
                    p_transaction_payload -> 'expected_component_versions' THEN
            RAISE EXCEPTION 'build_mutation_operation_id_conflict'
                USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_transaction;
        RETURN;
    END IF;

    v_now := clock_timestamp();
    IF NOT isfinite(v_lease_expires_at)
       OR v_lease_expires_at <= v_now
       OR v_lease_expires_at > v_now + INTERVAL '900 seconds' THEN
        RAISE EXCEPTION 'build_mutation_initial_lease_invalid'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.sophia_build_mutation_transactions (
        transaction_id,
        build_id,
        user_id,
        operation_id,
        expected_manifest_revision,
        status,
        lease_owner,
        lease_expires_at,
        transaction_payload
    ) VALUES (
        v_transaction_id,
        v_build_id,
        p_user_id,
        v_operation_id,
        v_expected_manifest_revision,
        'prepared',
        v_lease_owner,
        v_lease_expires_at,
        p_transaction_payload
    )
    RETURNING * INTO v_transaction;

    RETURN NEXT v_transaction;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_get_build_mutation_transaction(
    p_transaction_id TEXT,
    p_user_id TEXT
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT transaction.*
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.sophia_get_build_mutation_transaction_by_operation(
    p_build_id TEXT,
    p_user_id TEXT,
    p_operation_id TEXT
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT transaction.*
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.build_id = p_build_id
       AND transaction.user_id = p_user_id
       AND transaction.operation_id = p_operation_id;
$$;

CREATE OR REPLACE FUNCTION public.sophia_acquire_build_mutation_lease(
    p_transaction_id TEXT,
    p_user_id TEXT,
    p_lease_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lease_expires_at TIMESTAMPTZ;
    v_transaction public.sophia_build_mutation_transactions%ROWTYPE;
BEGIN
    IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
       OR p_user_id IS NULL OR btrim(p_user_id) = ''
       OR p_lease_owner IS NULL OR btrim(p_lease_owner) = ''
       OR char_length(p_lease_owner) > 256
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION 'build_mutation_lease_request_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT transaction.*
      INTO v_transaction
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_not_found'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_transaction.status IN ('committed', 'rolled_back', 'failed') THEN
        RAISE EXCEPTION 'build_mutation_terminal'
            USING ERRCODE = '55000';
    END IF;
    IF v_transaction.lease_owner IS DISTINCT FROM p_lease_owner
       AND v_transaction.lease_expires_at > clock_timestamp() THEN
        RAISE EXCEPTION 'build_mutation_lease_held'
            USING ERRCODE = '55000';
    END IF;

    v_lease_expires_at :=
        clock_timestamp() + make_interval(secs => p_lease_seconds);
    UPDATE public.sophia_build_mutation_transactions AS transaction
       SET lease_owner = p_lease_owner,
           lease_expires_at = v_lease_expires_at,
           transaction_payload = jsonb_set(
               jsonb_set(
                   transaction.transaction_payload,
                   '{lease_owner}',
                   to_jsonb(p_lease_owner),
                   true
               ),
               '{lease_expires_at}',
               to_jsonb(v_lease_expires_at),
               true
           ),
           updated_at = clock_timestamp()
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
    RETURNING transaction.* INTO v_transaction;

    RETURN NEXT v_transaction;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_renew_build_mutation_lease(
    p_transaction_id TEXT,
    p_user_id TEXT,
    p_lease_owner TEXT,
    p_expected_lease_expires_at TIMESTAMPTZ,
    p_lease_seconds INTEGER DEFAULT 120
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lease_expires_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ;
    v_transaction public.sophia_build_mutation_transactions%ROWTYPE;
BEGIN
    IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
       OR p_user_id IS NULL OR btrim(p_user_id) = ''
       OR p_lease_owner IS NULL OR btrim(p_lease_owner) = ''
       OR char_length(p_lease_owner) > 256
       OR p_expected_lease_expires_at IS NULL
       OR NOT isfinite(p_expected_lease_expires_at)
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 1 AND 900 THEN
        RAISE EXCEPTION 'build_mutation_lease_request_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT transaction.*
      INTO v_transaction
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_not_found'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_transaction.status IN ('committed', 'rolled_back', 'failed') THEN
        RAISE EXCEPTION 'build_mutation_terminal'
            USING ERRCODE = '55000';
    END IF;

    v_now := clock_timestamp();
    IF v_transaction.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_transaction.lease_expires_at
            IS DISTINCT FROM p_expected_lease_expires_at
       OR v_transaction.lease_expires_at <= v_now THEN
        RAISE EXCEPTION 'build_mutation_stale_lease'
            USING ERRCODE = '40001';
    END IF;

    v_lease_expires_at := GREATEST(
        v_now + make_interval(secs => p_lease_seconds),
        v_transaction.lease_expires_at + INTERVAL '1 microsecond'
    );
    UPDATE public.sophia_build_mutation_transactions AS transaction
       SET lease_expires_at = v_lease_expires_at,
           transaction_payload = jsonb_set(
               transaction.transaction_payload,
               '{lease_expires_at}',
               to_jsonb(v_lease_expires_at),
               true
           ),
           updated_at = clock_timestamp()
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
       AND transaction.status = v_transaction.status
       AND transaction.lease_owner = p_lease_owner
       AND transaction.lease_expires_at = p_expected_lease_expires_at
       AND transaction.lease_expires_at > clock_timestamp()
    RETURNING transaction.* INTO v_transaction;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_stale_lease'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_transaction;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_transition_build_mutation_transaction(
    p_transaction_id TEXT,
    p_user_id TEXT,
    p_lease_owner TEXT,
    p_expected_status TEXT,
    p_new_status TEXT,
    p_transaction_payload JSONB
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payload_lease_expires_at TIMESTAMPTZ;
    v_transaction public.sophia_build_mutation_transactions%ROWTYPE;
BEGIN
    IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
       OR p_user_id IS NULL OR btrim(p_user_id) = ''
       OR p_lease_owner IS NULL OR btrim(p_lease_owner) = ''
       OR jsonb_typeof(p_transaction_payload) <> 'object'
       OR p_transaction_payload ->> 'schema_version'
            IS DISTINCT FROM 'sophia-build-transaction/v1'
       OR p_transaction_payload ->> 'transaction_id'
            IS DISTINCT FROM p_transaction_id
       OR p_transaction_payload ->> 'user_id' IS DISTINCT FROM p_user_id
       OR p_transaction_payload ->> 'status' IS DISTINCT FROM p_new_status THEN
        RAISE EXCEPTION 'build_mutation_transition_payload_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF NOT (
        (p_expected_status = 'prepared'
            AND p_new_status IN ('staged', 'rolling_back', 'failed'))
        OR (p_expected_status = 'staged'
            AND p_new_status IN ('verified', 'rolling_back', 'failed'))
        OR (p_expected_status = 'verified'
            AND p_new_status IN ('committing', 'rolling_back', 'failed'))
        -- ``committed`` is deliberately absent.  Only
        -- sophia_commit_build_mutation_manifest may atomically advance the
        -- manifest head, registry, acceptance outbox, and transaction.
        OR (p_expected_status = 'committing'
            AND p_new_status IN ('rolling_back', 'failed'))
        OR (p_expected_status = 'rolling_back'
            AND p_new_status IN ('rolled_back', 'failed'))
    ) THEN
        RAISE EXCEPTION 'build_mutation_transition_invalid'
            USING ERRCODE = '22023';
    END IF;

    BEGIN
        v_payload_lease_expires_at :=
            (p_transaction_payload ->> 'lease_expires_at')::TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'build_mutation_transition_payload_invalid'
            USING ERRCODE = '22023';
    END;

    SELECT transaction.*
      INTO v_transaction
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_not_found'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_transaction.status IS DISTINCT FROM p_expected_status THEN
        RAISE EXCEPTION 'build_mutation_stale_transition'
            USING ERRCODE = '40001';
    END IF;
    IF v_transaction.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_transaction.lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'build_mutation_stale_lease'
            USING ERRCODE = '40001';
    END IF;

    IF p_transaction_payload ->> 'build_id'
            IS DISTINCT FROM v_transaction.build_id
       OR p_transaction_payload ->> 'operation_id'
            IS DISTINCT FROM v_transaction.operation_id
       OR p_transaction_payload ->> 'expected_manifest_revision'
            IS DISTINCT FROM v_transaction.expected_manifest_revision::TEXT
       OR p_transaction_payload ->> 'lease_owner'
            IS DISTINCT FROM v_transaction.lease_owner
       OR v_payload_lease_expires_at
            IS DISTINCT FROM v_transaction.lease_expires_at
       OR p_transaction_payload -> 'campaign_run_id'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'campaign_run_id'
       OR p_transaction_payload -> 'owner_thread_id'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'owner_thread_id'
       OR p_transaction_payload -> 'authorized_selectors'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'authorized_selectors'
       OR p_transaction_payload -> 'authorized_source_roles'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'authorized_source_roles'
       OR p_transaction_payload -> 'repair_program_hash'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'repair_program_hash'
       OR p_transaction_payload -> 'initial_quality_run_id'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'initial_quality_run_id'
       OR p_transaction_payload -> 'expected_artifact_version_id'
            IS DISTINCT FROM
                v_transaction.transaction_payload -> 'expected_artifact_version_id'
       OR p_transaction_payload -> 'expected_artifact_hash'
            IS DISTINCT FROM v_transaction.transaction_payload -> 'expected_artifact_hash'
       OR p_transaction_payload -> 'expected_component_versions'
            IS DISTINCT FROM
                v_transaction.transaction_payload -> 'expected_component_versions'
       OR (
            p_expected_status <> 'prepared'
            AND (
                p_transaction_payload -> 'staged_object_paths'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'staged_object_paths'
                OR p_transaction_payload -> 'candidate_version_ids'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'candidate_version_ids'
                OR p_transaction_payload -> 'candidate_manifest_object_path'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'candidate_manifest_object_path'
                OR p_transaction_payload -> 'candidate_manifest_hash'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'candidate_manifest_hash'
                OR p_transaction_payload -> 'candidate_artifact_version_id'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'candidate_artifact_version_id'
                OR p_transaction_payload -> 'candidate_artifact_hash'
                    IS DISTINCT FROM
                        v_transaction.transaction_payload -> 'candidate_artifact_hash'
            )
       )
       OR (
            v_transaction.transaction_payload ->> 'candidate_quality_run_id'
                IS NOT NULL
            AND p_transaction_payload -> 'candidate_quality_run_id'
                IS DISTINCT FROM
                    v_transaction.transaction_payload -> 'candidate_quality_run_id'
       )
       OR (
            v_transaction.transaction_payload ->> 'comparison_hash' IS NOT NULL
            AND p_transaction_payload -> 'comparison_hash'
                IS DISTINCT FROM
                    v_transaction.transaction_payload -> 'comparison_hash'
       )
       OR (
            p_expected_status NOT IN ('prepared', 'staged')
            AND p_transaction_payload -> 'gate_evidence'
                IS DISTINCT FROM
                    v_transaction.transaction_payload -> 'gate_evidence'
       ) THEN
        RAISE EXCEPTION 'build_mutation_identity_changed'
            USING ERRCODE = '22023';
    END IF;

    IF (p_transaction_payload ->> 'candidate_quality_run_id' IS NULL)
            <> (p_transaction_payload ->> 'comparison_hash' IS NULL)
       OR (
            p_transaction_payload ->> 'comparison_hash' IS NOT NULL
            AND (
                p_transaction_payload ->> 'comparison_hash'
                    !~ '^[0-9a-f]{64}$'
                OR p_transaction_payload ->> 'candidate_quality_run_id'
                    IS NOT DISTINCT FROM
                        p_transaction_payload ->> 'initial_quality_run_id'
            )
       )
       OR (
            v_transaction.transaction_payload ->> 'candidate_quality_run_id'
                IS NULL
            AND p_transaction_payload ->> 'candidate_quality_run_id' IS NOT NULL
            AND p_expected_status <> 'staged'
       ) THEN
        RAISE EXCEPTION 'build_mutation_comparison_invalid'
            USING ERRCODE = '22023';
    END IF;
    IF p_new_status = 'staged' THEN
        IF jsonb_typeof(p_transaction_payload -> 'staged_object_paths') <> 'array'
           OR jsonb_array_length(p_transaction_payload -> 'staged_object_paths') = 0
           OR jsonb_typeof(p_transaction_payload -> 'candidate_version_ids') <> 'array'
           OR jsonb_array_length(p_transaction_payload -> 'candidate_version_ids') = 0
           OR COALESCE(
                p_transaction_payload ->> 'candidate_manifest_object_path', ''
              ) IS DISTINCT FROM (
                'artifacts/' || p_user_id || '/'
                || (p_transaction_payload ->> 'owner_thread_id')
                || '/foundation/.builder/builds/'
                || v_transaction.build_id || '/manifest/manifest-r'
                || (v_transaction.expected_manifest_revision + 1)::TEXT
                || '.json'
           )
           OR COALESCE(p_transaction_payload ->> 'candidate_manifest_hash', '')
                !~ '^[0-9a-f]{64}$'
           OR NULLIF(
                btrim(p_transaction_payload ->> 'candidate_artifact_version_id'), ''
              ) IS NULL
           OR char_length(
                p_transaction_payload ->> 'candidate_artifact_version_id'
              ) > 512
           OR COALESCE(p_transaction_payload ->> 'candidate_artifact_hash', '')
                !~ '^[0-9a-f]{64}$'
           OR p_transaction_payload ->> 'candidate_artifact_version_id'
                IS NOT DISTINCT FROM
                    p_transaction_payload ->> 'expected_artifact_version_id'
           OR NOT (
                p_transaction_payload -> 'candidate_version_ids'
                    @> jsonb_build_array(
                        p_transaction_payload ->> 'candidate_artifact_version_id'
                    )
           )
           OR NOT (
                p_transaction_payload -> 'staged_object_paths'
                    @> jsonb_build_array(
                        p_transaction_payload ->> 'candidate_manifest_object_path'
                    )
           )
           OR NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements_text(
                      p_transaction_payload -> 'staged_object_paths'
                  ) AS candidate_path(value)
                 WHERE left(
                    candidate_path.value,
                    char_length(
                        'artifacts/' || p_user_id || '/'
                        || (p_transaction_payload ->> 'owner_thread_id')
                        || '/foundation/.builder/builds/'
                        || v_transaction.build_id || '/artifacts/'
                        || (p_transaction_payload ->> 'candidate_artifact_version_id')
                        || '/'
                    )
                 ) = (
                    'artifacts/' || p_user_id || '/'
                    || (p_transaction_payload ->> 'owner_thread_id')
                    || '/foundation/.builder/builds/'
                    || v_transaction.build_id || '/artifacts/'
                    || (p_transaction_payload ->> 'candidate_artifact_version_id')
                    || '/'
                 )
           )
           OR p_transaction_payload ->> 'candidate_quality_run_id' IS NOT NULL
           OR p_transaction_payload ->> 'comparison_hash' IS NOT NULL
           OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(
                      p_transaction_payload -> 'staged_object_paths'
                  ) AS object_path(value)
                 WHERE jsonb_typeof(object_path.value) <> 'string'
                    OR char_length(object_path.value #>> '{}') NOT BETWEEN 1 AND 4096
                    OR object_path.value #>> '{}' !~
                        '^[A-Za-z0-9._=-]+(/[A-Za-z0-9._=-]+)*$'
                    OR object_path.value #>> '{}' ~ '(^|/)\.\.?(/|$)'
                    OR left(
                        object_path.value #>> '{}',
                        char_length(
                            'artifacts/' || p_user_id || '/'
                            || (p_transaction_payload ->> 'owner_thread_id')
                            || '/foundation/.builder/builds/'
                            || v_transaction.build_id || '/'
                        )
                    ) <> (
                        'artifacts/' || p_user_id || '/'
                        || (p_transaction_payload ->> 'owner_thread_id')
                        || '/foundation/.builder/builds/'
                        || v_transaction.build_id || '/'
                    )
           )
           OR (
                SELECT count(*) <> count(DISTINCT object_path.value #>> '{}')
                  FROM jsonb_array_elements(
                      p_transaction_payload -> 'staged_object_paths'
                  ) AS object_path(value)
           )
           OR EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(
                      p_transaction_payload -> 'candidate_version_ids'
                  ) AS version(value)
                 WHERE jsonb_typeof(version.value) <> 'string'
                    OR char_length(btrim(version.value #>> '{}')) NOT BETWEEN 1 AND 512
           )
           OR (
                SELECT count(*) <> count(DISTINCT version.value #>> '{}')
                  FROM jsonb_array_elements(
                      p_transaction_payload -> 'candidate_version_ids'
                  ) AS version(value)
           ) THEN
            RAISE EXCEPTION 'build_mutation_staged_identity_invalid'
                USING ERRCODE = '22023';
        END IF;
    ELSIF p_expected_status = 'prepared' AND (
        jsonb_typeof(p_transaction_payload -> 'staged_object_paths') <> 'array'
        OR jsonb_array_length(p_transaction_payload -> 'staged_object_paths') <> 0
        OR jsonb_typeof(p_transaction_payload -> 'candidate_version_ids') <> 'array'
        OR jsonb_array_length(p_transaction_payload -> 'candidate_version_ids') <> 0
        OR p_transaction_payload ->> 'candidate_manifest_object_path' IS NOT NULL
        OR p_transaction_payload ->> 'candidate_manifest_hash' IS NOT NULL
        OR p_transaction_payload ->> 'candidate_artifact_version_id' IS NOT NULL
        OR p_transaction_payload ->> 'candidate_artifact_hash' IS NOT NULL
        OR p_transaction_payload ->> 'candidate_quality_run_id' IS NOT NULL
        OR p_transaction_payload ->> 'comparison_hash' IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'build_mutation_prepared_staged_identity_invalid'
            USING ERRCODE = '22023';
    END IF;
    IF p_new_status IN ('verified', 'committing', 'committed')
       AND (
            NULLIF(
                btrim(p_transaction_payload ->> 'candidate_quality_run_id'), ''
            ) IS NULL
            OR COALESCE(p_transaction_payload ->> 'comparison_hash', '')
                !~ '^[0-9a-f]{64}$'
            OR jsonb_typeof(p_transaction_payload -> 'gate_evidence') <> 'object'
            OR p_transaction_payload -> 'gate_evidence' = '{}'::JSONB
       ) THEN
        RAISE EXCEPTION 'build_mutation_comparison_required'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.sophia_build_mutation_transactions AS transaction
       SET status = p_new_status,
           transaction_payload = p_transaction_payload,
           updated_at = clock_timestamp()
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
       AND transaction.status = p_expected_status
       AND transaction.lease_owner = p_lease_owner
       AND transaction.lease_expires_at > clock_timestamp()
    RETURNING transaction.* INTO v_transaction;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_stale_transition'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_transaction;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_recover_build_mutation_transactions(
    p_build_id TEXT,
    p_user_id TEXT,
    p_lease_owner TEXT,
    p_lease_seconds INTEGER DEFAULT 120,
    p_limit INTEGER DEFAULT 50
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lease_expires_at TIMESTAMPTZ;
BEGIN
    IF p_build_id IS NULL OR btrim(p_build_id) = ''
       OR p_user_id IS NULL OR btrim(p_user_id) = ''
       OR p_lease_owner IS NULL OR btrim(p_lease_owner) = ''
       OR char_length(p_lease_owner) > 256
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 1 AND 900
       OR p_limit IS NULL
       OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'build_mutation_recovery_request_invalid'
            USING ERRCODE = '22023';
    END IF;

    v_lease_expires_at :=
        clock_timestamp() + make_interval(secs => p_lease_seconds);
    RETURN QUERY
    WITH recoverable AS (
        SELECT transaction.transaction_id
          FROM public.sophia_build_mutation_transactions AS transaction
         WHERE transaction.user_id = p_user_id
           AND transaction.build_id = p_build_id
           AND transaction.status NOT IN ('committed', 'rolled_back', 'failed')
           AND transaction.lease_expires_at <= clock_timestamp()
           -- The table deliberately retains valid pre-DQ-2 rows.  Recovery is
           -- a DQ-2 controller boundary and must never claim those rows.
           AND jsonb_typeof(
               transaction.transaction_payload -> 'campaign_run_id'
           ) = 'string'
           AND NULLIF(btrim(
               transaction.transaction_payload ->> 'campaign_run_id'
           ), '') IS NOT NULL
           AND char_length(
               transaction.transaction_payload ->> 'campaign_run_id'
           ) <= 512
           AND jsonb_typeof(
               transaction.transaction_payload -> 'owner_thread_id'
           ) = 'string'
           AND COALESCE(
               transaction.transaction_payload ->> 'owner_thread_id', ''
           ) ~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$'
           AND jsonb_typeof(
               transaction.transaction_payload -> 'initial_quality_run_id'
           ) = 'string'
           AND NULLIF(btrim(
               transaction.transaction_payload ->> 'initial_quality_run_id'
           ), '') IS NOT NULL
           AND char_length(
               transaction.transaction_payload ->> 'initial_quality_run_id'
           ) <= 512
           AND jsonb_typeof(
               transaction.transaction_payload -> 'repair_program_hash'
           ) = 'string'
           AND COALESCE(
               transaction.transaction_payload ->> 'repair_program_hash', ''
           ) ~ '^[0-9a-f]{64}$'
           AND jsonb_typeof(
               transaction.transaction_payload
                   -> 'expected_artifact_version_id'
           ) = 'string'
           AND NULLIF(btrim(
               transaction.transaction_payload
                   ->> 'expected_artifact_version_id'
           ), '') IS NOT NULL
           AND char_length(
               transaction.transaction_payload
                   ->> 'expected_artifact_version_id'
           ) <= 512
           AND jsonb_typeof(
               transaction.transaction_payload -> 'expected_artifact_hash'
           ) = 'string'
           AND COALESCE(
               transaction.transaction_payload ->> 'expected_artifact_hash', ''
           ) ~ '^[0-9a-f]{64}$'
           AND CASE
               WHEN jsonb_typeof(
                   transaction.transaction_payload
                       -> 'expected_component_versions'
               ) = 'object' THEN
                   transaction.transaction_payload
                       -> 'expected_component_versions' <> '{}'::JSONB
                   AND NOT EXISTS (
                       SELECT 1
                         FROM jsonb_each(
                             transaction.transaction_payload
                                 -> 'expected_component_versions'
                         ) AS component(selector, version)
                        WHERE NULLIF(btrim(component.selector), '') IS NULL
                           OR char_length(component.selector) > 512
                           OR jsonb_typeof(component.version) <> 'string'
                           OR NULLIF(
                               btrim(component.version #>> '{}'), ''
                           ) IS NULL
                           OR char_length(component.version #>> '{}') > 512
                   )
               ELSE false
           END
           AND CASE
               WHEN jsonb_typeof(
                   transaction.transaction_payload -> 'authorized_selectors'
               ) = 'array' THEN
                   transaction.transaction_payload
                       -> 'authorized_selectors' <> '[]'::JSONB
                   AND NOT EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements(
                             transaction.transaction_payload
                                 -> 'authorized_selectors'
                         ) AS selector(value)
                        WHERE jsonb_typeof(selector.value) <> 'string'
                           OR NULLIF(
                               btrim(selector.value #>> '{}'), ''
                           ) IS NULL
                           OR char_length(selector.value #>> '{}') > 512
                   )
                   AND (
                       SELECT count(*) = count(DISTINCT selector.value #>> '{}')
                         FROM jsonb_array_elements(
                             transaction.transaction_payload
                                 -> 'authorized_selectors'
                         ) AS selector(value)
                   )
                   AND NOT EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements_text(
                             transaction.transaction_payload
                                 -> 'authorized_selectors'
                         ) AS selector(value)
                        WHERE NOT (
                            transaction.transaction_payload
                                -> 'expected_component_versions'
                                ? selector.value
                        )
                   )
               ELSE false
           END
           AND CASE
               WHEN jsonb_typeof(
                   transaction.transaction_payload -> 'authorized_source_roles'
               ) = 'object'
               AND jsonb_typeof(
                   transaction.transaction_payload -> 'authorized_selectors'
               ) = 'array' THEN
                   transaction.transaction_payload
                       -> 'authorized_source_roles' <> '{}'::JSONB
                   AND (
                       SELECT count(*)
                         FROM jsonb_object_keys(
                             transaction.transaction_payload
                                 -> 'authorized_source_roles'
                         ) AS source_role(selector)
                   ) = (
                       SELECT count(*)
                         FROM jsonb_array_elements(
                             transaction.transaction_payload
                                 -> 'authorized_selectors'
                         ) AS selector(value)
                   )
                   AND NOT EXISTS (
                       SELECT 1
                         FROM jsonb_array_elements_text(
                             transaction.transaction_payload
                                 -> 'authorized_selectors'
                         ) AS selector(value)
                        WHERE NOT (
                            transaction.transaction_payload
                                -> 'authorized_source_roles'
                                ? selector.value
                        )
                   )
                   AND NOT EXISTS (
                       SELECT 1
                         FROM jsonb_each(
                             transaction.transaction_payload
                                 -> 'authorized_source_roles'
                         ) AS role(selector, roles)
                        WHERE CASE
                            WHEN jsonb_typeof(role.roles) = 'array' THEN
                                jsonb_array_length(role.roles) = 0
                                OR EXISTS (
                                    SELECT 1
                                      FROM jsonb_array_elements(
                                          role.roles
                                      ) AS source_role(value)
                                     WHERE jsonb_typeof(source_role.value)
                                            <> 'string'
                                        OR NULLIF(btrim(
                                            source_role.value #>> '{}'
                                        ), '') IS NULL
                                        OR char_length(
                                            source_role.value #>> '{}'
                                        ) > 256
                                )
                                OR (
                                    SELECT count(*) <>
                                            count(DISTINCT source_role.value #>> '{}')
                                      FROM jsonb_array_elements(
                                          role.roles
                                      ) AS source_role(value)
                                )
                            ELSE true
                        END
                   )
               ELSE false
           END
           AND jsonb_typeof(
               transaction.transaction_payload -> 'gate_evidence'
           ) = 'object'
           AND transaction.transaction_payload -> 'gate_evidence' <> '{}'::JSONB
           AND CASE
               WHEN transaction.transaction_payload
                       ->> 'candidate_quality_run_id' IS NULL
                    AND transaction.transaction_payload
                       ->> 'comparison_hash' IS NULL THEN
                   transaction.status NOT IN ('verified', 'committing')
               WHEN (
                   jsonb_typeof(
                       transaction.transaction_payload
                           -> 'candidate_quality_run_id'
                   ) = 'string'
                   AND jsonb_typeof(
                       transaction.transaction_payload -> 'comparison_hash'
                   ) = 'string'
                   AND
                   NULLIF(btrim(
                       transaction.transaction_payload
                           ->> 'candidate_quality_run_id'
                   ), '') IS NOT NULL
                   AND char_length(
                       transaction.transaction_payload
                           ->> 'candidate_quality_run_id'
                   ) <= 512
                   AND transaction.transaction_payload
                           ->> 'candidate_quality_run_id'
                       IS DISTINCT FROM transaction.transaction_payload
                           ->> 'initial_quality_run_id'
                   AND COALESCE(
                       transaction.transaction_payload ->> 'comparison_hash', ''
                   ) ~ '^[0-9a-f]{64}$'
               ) THEN true
               ELSE false
           END
         ORDER BY transaction.updated_at, transaction.transaction_id
         LIMIT p_limit
         FOR UPDATE SKIP LOCKED
    )
    UPDATE public.sophia_build_mutation_transactions AS transaction
       SET lease_owner = p_lease_owner,
           lease_expires_at = v_lease_expires_at,
           transaction_payload = jsonb_set(
               jsonb_set(
                   transaction.transaction_payload,
                   '{lease_owner}',
                   to_jsonb(p_lease_owner),
                   true
               ),
               '{lease_expires_at}',
               to_jsonb(v_lease_expires_at),
               true
           ),
           updated_at = clock_timestamp()
      FROM recoverable
     WHERE transaction.transaction_id = recoverable.transaction_id
    RETURNING transaction.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_get_build_manifest_head(
    p_build_id TEXT,
    p_user_id TEXT
) RETURNS SETOF public.sophia_build_manifest_heads
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT head.*
      FROM public.sophia_build_manifest_heads AS head
     WHERE head.build_id = p_build_id
       AND head.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.sophia_commit_build_mutation_manifest(
    p_transaction_id TEXT,
    p_user_id TEXT,
    p_lease_owner TEXT,
    p_lease_expires_at TIMESTAMPTZ,
    p_owner_thread_id TEXT,
    p_manifest_object_path TEXT,
    p_manifest_hash TEXT,
    p_logical_artifact_id TEXT,
    p_artifact_version_id TEXT,
    p_status TEXT,
    p_format TEXT,
    p_project_id TEXT,
    p_acceptance_payload JSONB
) RETURNS SETOF public.sophia_build_mutation_transactions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_head public.sophia_build_manifest_heads%ROWTYPE;
    v_idempotency_key TEXT;
    v_new_revision BIGINT;
    v_expected_manifest_object_path TEXT;
    v_expected_artifact_prefix TEXT;
    v_registry public.sophia_build_registry%ROWTYPE;
    v_transaction public.sophia_build_mutation_transactions%ROWTYPE;
BEGIN
    IF p_transaction_id IS NULL OR btrim(p_transaction_id) = ''
       OR p_user_id IS NULL OR btrim(p_user_id) = ''
       OR p_lease_owner IS NULL OR btrim(p_lease_owner) = ''
       OR p_lease_expires_at IS NULL OR NOT isfinite(p_lease_expires_at)
       OR p_owner_thread_id IS NULL OR btrim(p_owner_thread_id) = ''
       OR p_manifest_object_path IS NULL
       OR COALESCE(p_manifest_hash, '') !~ '^[0-9a-f]{64}$'
       OR p_logical_artifact_id IS NULL OR btrim(p_logical_artifact_id) = ''
       OR p_artifact_version_id IS NULL OR btrim(p_artifact_version_id) = ''
       OR p_status IS NULL OR btrim(p_status) = ''
       OR p_format IS NULL OR btrim(p_format) = ''
       OR jsonb_typeof(p_acceptance_payload) <> 'object' THEN
        RAISE EXCEPTION 'build_mutation_manifest_commit_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT transaction.*
      INTO v_transaction
      FROM public.sophia_build_mutation_transactions AS transaction
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_not_found'
            USING ERRCODE = 'P0002';
    END IF;
    IF v_transaction.build_id IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'build_id'
       OR v_transaction.expected_manifest_revision IS DISTINCT FROM
            (v_transaction.transaction_payload ->> 'expected_manifest_revision')::BIGINT
       OR v_transaction.transaction_payload ->> 'owner_thread_id'
            IS DISTINCT FROM p_owner_thread_id
       OR v_transaction.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_transaction.lease_expires_at IS DISTINCT FROM p_lease_expires_at THEN
        RAISE EXCEPTION 'build_mutation_manifest_commit_identity_changed'
            USING ERRCODE = '22023';
    END IF;

    v_new_revision := v_transaction.expected_manifest_revision + 1;
    IF p_user_id !~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$'
       OR p_owner_thread_id !~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$'
       OR v_transaction.build_id !~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$'
       OR p_artifact_version_id !~ '^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$' THEN
        RAISE EXCEPTION 'build_mutation_manifest_scope_invalid'
            USING ERRCODE = '22023';
    END IF;
    v_expected_manifest_object_path :=
        'artifacts/' || p_user_id || '/' || p_owner_thread_id
        || '/foundation/.builder/builds/' || v_transaction.build_id
        || '/manifest/manifest-r' || v_new_revision::TEXT || '.json';
    v_expected_artifact_prefix :=
        'artifacts/' || p_user_id || '/' || p_owner_thread_id
        || '/foundation/.builder/builds/' || v_transaction.build_id
        || '/artifacts/' || p_artifact_version_id || '/';
    IF p_manifest_object_path IS DISTINCT FROM v_expected_manifest_object_path
       OR left(
            COALESCE(p_acceptance_payload ->> 'storage_object_path', ''),
            char_length(v_expected_artifact_prefix)
          ) IS DISTINCT FROM v_expected_artifact_prefix THEN
        RAISE EXCEPTION 'build_mutation_manifest_scope_invalid'
            USING ERRCODE = '22023';
    END IF;
    v_idempotency_key :=
        p_logical_artifact_id || ':' || p_artifact_version_id || ':' || v_new_revision::TEXT;

    IF p_acceptance_payload ->> 'build_id' IS DISTINCT FROM v_transaction.build_id
       OR p_acceptance_payload ->> 'logical_artifact_id'
            IS DISTINCT FROM p_logical_artifact_id
       OR p_acceptance_payload ->> 'artifact_version_id'
            IS DISTINCT FROM p_artifact_version_id
       OR p_acceptance_payload ->> 'manifest_revision'
            IS DISTINCT FROM v_new_revision::TEXT
       OR p_acceptance_payload ->> 'artifact_type' IS DISTINCT FROM p_format
       OR p_acceptance_payload ->> 'project_id' IS DISTINCT FROM p_project_id
       OR p_acceptance_payload ->> 'origin' IS DISTINCT FROM 'quality_repair' THEN
        RAISE EXCEPTION 'build_mutation_acceptance_identity_invalid'
            USING ERRCODE = '22023';
    END IF;

    IF v_transaction.status = 'committed' THEN
        SELECT head.*
          INTO v_head
          FROM public.sophia_build_manifest_heads AS head
         WHERE head.build_id = v_transaction.build_id
           AND head.user_id = p_user_id;
        IF NOT FOUND
           OR v_transaction.transaction_payload ->> 'committed_manifest_revision'
                IS DISTINCT FROM v_new_revision::TEXT
           OR v_head.manifest_revision IS DISTINCT FROM v_new_revision
           OR v_head.manifest_object_path IS DISTINCT FROM p_manifest_object_path
           OR v_head.manifest_hash IS DISTINCT FROM p_manifest_hash
           OR v_head.owner_thread_id IS DISTINCT FROM p_owner_thread_id
           OR v_head.logical_artifact_id IS DISTINCT FROM p_logical_artifact_id
           OR v_head.current_artifact_version_id IS DISTINCT FROM p_artifact_version_id
           OR v_head.status IS DISTINCT FROM p_status
           OR v_head.format IS DISTINCT FROM p_format
           OR NOT EXISTS (
                SELECT 1
                  FROM public.sophia_build_registry AS registry
                 WHERE registry.user_id = p_user_id
                   AND registry.build_id = v_transaction.build_id
                   AND registry.current_manifest_revision = v_new_revision
                   AND registry.current_artifact_version_id = p_artifact_version_id
                   AND registry.manifest_object_path = p_manifest_object_path
                   AND registry.owner_thread_id = p_owner_thread_id
                   AND registry.logical_artifact_id = p_logical_artifact_id
                   AND registry.status = p_status
                   AND registry.format = p_format
                   AND (
                        p_project_id IS NULL
                        OR registry.project_id IS NOT DISTINCT FROM p_project_id
                   )
           )
           OR NOT EXISTS (
                SELECT 1
                  FROM public.sophia_build_acceptance_outbox AS outbox
                 WHERE outbox.idempotency_key = v_idempotency_key
                   AND outbox.build_id = v_transaction.build_id
                   AND outbox.user_id = p_user_id
                   AND outbox.payload = p_acceptance_payload
           ) THEN
            RAISE EXCEPTION 'build_mutation_manifest_commit_replay_conflict'
                USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_transaction;
        RETURN;
    END IF;

    IF v_transaction.status IS DISTINCT FROM 'committing'
       OR v_transaction.lease_expires_at <= clock_timestamp() THEN
        RAISE EXCEPTION 'build_mutation_stale_commit_lease'
            USING ERRCODE = '40001';
    END IF;
    IF jsonb_typeof(v_transaction.transaction_payload -> 'candidate_version_ids')
            <> 'array'
       OR NOT (
            v_transaction.transaction_payload -> 'candidate_version_ids'
            @> jsonb_build_array(p_artifact_version_id)
       )
       OR p_artifact_version_id IS NOT DISTINCT FROM
            v_transaction.transaction_payload ->> 'expected_artifact_version_id'
       OR p_artifact_version_id IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'candidate_artifact_version_id'
       OR p_manifest_object_path IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'candidate_manifest_object_path'
       OR p_manifest_hash IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'candidate_manifest_hash'
       OR COALESCE(
            v_transaction.transaction_payload ->> 'candidate_artifact_hash', ''
          ) !~ '^[0-9a-f]{64}$'
       OR NOT (
            v_transaction.transaction_payload -> 'staged_object_paths'
                @> jsonb_build_array(p_manifest_object_path)
       )
       OR NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                  v_transaction.transaction_payload -> 'staged_object_paths'
              ) AS candidate_path(value)
             WHERE left(
                candidate_path.value,
                char_length(v_expected_artifact_prefix)
             ) = v_expected_artifact_prefix
       )
       OR NULLIF(
            btrim(v_transaction.transaction_payload ->> 'candidate_quality_run_id'), ''
          ) IS NULL
       OR v_transaction.transaction_payload ->> 'candidate_quality_run_id'
            IS NOT DISTINCT FROM
                v_transaction.transaction_payload ->> 'initial_quality_run_id'
       OR COALESCE(v_transaction.transaction_payload ->> 'comparison_hash', '')
            !~ '^[0-9a-f]{64}$'
       OR jsonb_typeof(v_transaction.transaction_payload -> 'gate_evidence')
            <> 'object'
       OR v_transaction.transaction_payload -> 'gate_evidence' = '{}'::JSONB THEN
        RAISE EXCEPTION 'build_mutation_candidate_identity_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT head.*
      INTO v_head
      FROM public.sophia_build_manifest_heads AS head
     WHERE head.build_id = v_transaction.build_id
       AND head.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND
       OR v_head.manifest_revision IS DISTINCT FROM
            v_transaction.expected_manifest_revision
       OR v_head.owner_thread_id IS DISTINCT FROM p_owner_thread_id
       OR v_head.current_artifact_version_id IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'expected_artifact_version_id'
       OR v_head.manifest_object_path IS NOT DISTINCT FROM p_manifest_object_path
       OR (
            v_head.logical_artifact_id IS NOT NULL
            AND v_head.logical_artifact_id IS DISTINCT FROM p_logical_artifact_id
       ) THEN
        RAISE EXCEPTION 'build_manifest_concurrent_modification'
            USING ERRCODE = '40001';
    END IF;

    SELECT registry.*
      INTO v_registry
      FROM public.sophia_build_registry AS registry
     WHERE registry.user_id = p_user_id
       AND registry.build_id = v_transaction.build_id
     FOR UPDATE;

    IF NOT FOUND
       OR v_registry.current_manifest_revision IS DISTINCT FROM
            v_transaction.expected_manifest_revision
       OR v_registry.owner_thread_id IS DISTINCT FROM p_owner_thread_id
       OR (
            v_registry.logical_artifact_id IS NOT NULL
            AND v_registry.logical_artifact_id IS DISTINCT FROM p_logical_artifact_id
       )
       OR v_registry.current_artifact_version_id IS DISTINCT FROM
            v_transaction.transaction_payload ->> 'expected_artifact_version_id'
       OR v_registry.manifest_object_path IS DISTINCT FROM v_head.manifest_object_path THEN
        RAISE EXCEPTION 'build_registry_concurrent_modification'
            USING ERRCODE = '40001';
    END IF;

    UPDATE public.sophia_build_manifest_heads AS head
       SET owner_thread_id = p_owner_thread_id,
           manifest_revision = v_new_revision,
           manifest_object_path = p_manifest_object_path,
           manifest_hash = p_manifest_hash,
           logical_artifact_id = COALESCE(head.logical_artifact_id, p_logical_artifact_id),
           current_artifact_version_id = p_artifact_version_id,
           status = p_status,
           format = p_format,
           updated_at = clock_timestamp()
     WHERE head.build_id = v_transaction.build_id
       AND head.user_id = p_user_id
       AND head.manifest_revision = v_transaction.expected_manifest_revision;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_manifest_concurrent_modification'
            USING ERRCODE = '40001';
    END IF;

    UPDATE public.sophia_build_registry AS registry
       SET owner_thread_id = p_owner_thread_id,
           logical_artifact_id = COALESCE(
               registry.logical_artifact_id,
               p_logical_artifact_id
           ),
           current_artifact_version_id = p_artifact_version_id,
           manifest_object_path = p_manifest_object_path,
           current_manifest_revision = v_new_revision,
           status = p_status,
           format = p_format,
           project_id = COALESCE(p_project_id, registry.project_id),
           registry_sync_pending = false,
           updated_at = clock_timestamp()
     WHERE registry.user_id = p_user_id
       AND registry.build_id = v_transaction.build_id
       AND registry.current_manifest_revision =
            v_transaction.expected_manifest_revision
       AND registry.current_artifact_version_id IS NOT DISTINCT FROM
            v_transaction.transaction_payload ->> 'expected_artifact_version_id';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_registry_concurrent_modification'
            USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.sophia_build_acceptance_outbox (
        idempotency_key, build_id, user_id, logical_artifact_id,
        artifact_version_id, manifest_revision, payload
    ) VALUES (
        v_idempotency_key, v_transaction.build_id, p_user_id, p_logical_artifact_id,
        p_artifact_version_id, v_new_revision, p_acceptance_payload
    );

    UPDATE public.sophia_build_mutation_transactions AS transaction
       SET status = 'committed',
           transaction_payload = jsonb_set(
               jsonb_set(
                   transaction.transaction_payload,
                   '{status}',
                   to_jsonb('committed'::TEXT),
                   true
               ),
               '{committed_manifest_revision}',
               to_jsonb(v_new_revision),
               true
           ),
           updated_at = clock_timestamp()
     WHERE transaction.transaction_id = p_transaction_id
       AND transaction.user_id = p_user_id
       AND transaction.status = 'committing'
       AND transaction.lease_owner = p_lease_owner
       AND transaction.lease_expires_at = p_lease_expires_at
       AND transaction.lease_expires_at > clock_timestamp()
    RETURNING transaction.* INTO v_transaction;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'build_mutation_stale_commit_lease'
            USING ERRCODE = '40001';
    END IF;
    RETURN NEXT v_transaction;
END;
$$;

ALTER FUNCTION public.sophia_create_build_mutation_transaction(TEXT, JSONB)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_get_build_mutation_transaction(TEXT, TEXT)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_get_build_mutation_transaction_by_operation(
    TEXT, TEXT, TEXT
) OWNER TO postgres;
ALTER FUNCTION public.sophia_acquire_build_mutation_lease(TEXT, TEXT, TEXT, INTEGER)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_renew_build_mutation_lease(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER
) OWNER TO postgres;
ALTER FUNCTION public.sophia_transition_build_mutation_transaction(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) OWNER TO postgres;
ALTER FUNCTION public.sophia_recover_build_mutation_transactions(
    TEXT, TEXT, TEXT, INTEGER, INTEGER
) OWNER TO postgres;
ALTER FUNCTION public.sophia_get_build_manifest_head(TEXT, TEXT)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_commit_build_mutation_manifest(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.sophia_create_build_mutation_transaction(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_get_build_mutation_transaction(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_get_build_mutation_transaction_by_operation(
    TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_acquire_build_mutation_lease(TEXT, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_renew_build_mutation_lease(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_transition_build_mutation_transaction(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_recover_build_mutation_transactions(
    TEXT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_get_build_manifest_head(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sophia_commit_build_mutation_manifest(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

DO $function_acl_convergence$
DECLARE
    v_principal RECORD;
    v_procedure RECORD;
BEGIN
    FOR v_procedure IN
        SELECT procedure.oid::REGPROCEDURE AS identity
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
         WHERE namespace.nspname = 'public'
           AND procedure.proname IN (
                'sophia_create_build_mutation_transaction',
                'sophia_get_build_mutation_transaction',
                'sophia_get_build_mutation_transaction_by_operation',
                'sophia_acquire_build_mutation_lease',
                'sophia_renew_build_mutation_lease',
                'sophia_transition_build_mutation_transaction',
                'sophia_recover_build_mutation_transactions',
                'sophia_get_build_manifest_head',
                'sophia_commit_build_mutation_manifest'
           )
    LOOP
        EXECUTE format(
            'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
            v_procedure.identity
        );
        FOR v_principal IN
            SELECT role.rolname
              FROM pg_catalog.pg_roles AS role
             WHERE role.oid <> 'postgres'::REGROLE
        LOOP
            EXECUTE format(
                'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
                v_procedure.identity,
                v_principal.rolname
            );
        END LOOP;
    END LOOP;
END;
$function_acl_convergence$;

GRANT EXECUTE ON FUNCTION public.sophia_create_build_mutation_transaction(TEXT, JSONB)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_get_build_mutation_transaction(TEXT, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_get_build_mutation_transaction_by_operation(
    TEXT, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_acquire_build_mutation_lease(TEXT, TEXT, TEXT, INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_renew_build_mutation_lease(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_transition_build_mutation_transaction(
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_recover_build_mutation_transactions(
    TEXT, TEXT, TEXT, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_get_build_manifest_head(TEXT, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.sophia_commit_build_mutation_manifest(
    TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
    TEXT, TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

DO $postflight$
DECLARE
    v_table_secure BOOLEAN;
    v_table_acl_secure BOOLEAN;
    v_policy_count INTEGER;
    v_function_count INTEGER;
    v_function_acl_secure BOOLEAN;
BEGIN
    SELECT relation.relrowsecurity AND relation.relforcerowsecurity
      INTO v_table_secure
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid =
        'public.sophia_build_mutation_transactions'::REGCLASS;

    SELECT count(*)
      INTO v_policy_count
      FROM pg_catalog.pg_policy
     WHERE polrelid =
        'public.sophia_build_mutation_transactions'::REGCLASS;

    SELECT NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.aclexplode(
                     COALESCE(
                         relation.relacl,
                         pg_catalog.acldefault('r', relation.relowner)
                     )
                 ) AS privilege
                WHERE privilege.grantee <> relation.relowner
           )
      INTO v_table_acl_secure
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid =
        'public.sophia_build_mutation_transactions'::REGCLASS;

    SELECT count(*)
      INTO v_function_count
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname IN (
            'sophia_create_build_mutation_transaction',
            'sophia_get_build_mutation_transaction',
            'sophia_get_build_mutation_transaction_by_operation',
            'sophia_acquire_build_mutation_lease',
            'sophia_renew_build_mutation_lease',
            'sophia_transition_build_mutation_transaction',
            'sophia_recover_build_mutation_transactions',
            'sophia_get_build_manifest_head',
            'sophia_commit_build_mutation_manifest'
       )
       AND procedure.prosecdef
       AND procedure.proowner = 'postgres'::REGROLE
       AND procedure.proconfig @> ARRAY['search_path=public, pg_temp']::TEXT[];

    SELECT count(*) = 9
           AND bool_and(
               pg_catalog.has_function_privilege(
                   'service_role', procedure.oid, 'EXECUTE'
               )
               AND NOT pg_catalog.has_function_privilege(
                   'anon', procedure.oid, 'EXECUTE'
               )
               AND NOT pg_catalog.has_function_privilege(
                   'authenticated', procedure.oid, 'EXECUTE'
               )
               AND NOT EXISTS (
                   SELECT 1
                     FROM pg_catalog.aclexplode(
                         COALESCE(
                             procedure.proacl,
                             pg_catalog.acldefault('f', procedure.proowner)
                         )
                     ) AS privilege
                    WHERE privilege.grantee NOT IN (
                        procedure.proowner,
                        'service_role'::REGROLE
                    )
               )
           )
      INTO v_function_acl_secure
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure.proname IN (
            'sophia_create_build_mutation_transaction',
            'sophia_get_build_mutation_transaction',
            'sophia_get_build_mutation_transaction_by_operation',
            'sophia_acquire_build_mutation_lease',
            'sophia_renew_build_mutation_lease',
            'sophia_transition_build_mutation_transaction',
            'sophia_recover_build_mutation_transactions',
            'sophia_get_build_manifest_head',
            'sophia_commit_build_mutation_manifest'
       );

    IF v_table_secure IS DISTINCT FROM true
       OR v_table_acl_secure IS DISTINCT FROM true
       OR v_policy_count <> 0
       OR v_function_count <> 9
       OR v_function_acl_secure IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'build_mutation_postflight_failed'
            USING ERRCODE = '42501';
    END IF;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
