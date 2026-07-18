-- DQ-1 independent producer double-storage-failure evidence.
--
-- This forward-only surface is intentionally separate from both the artifact
-- object store and the publication outbox. Only service-role RPCs can observe
-- or mutate it. Identical response-loss replays are idempotent; a conflicting
-- replay is durably latched and reopens readiness before the RPC returns.

BEGIN;

-- Accept only an entirely empty namespace or the exact v1 surface installed
-- below.  This guard intentionally runs before CREATE TABLE, COMMENT, ALTER,
-- REVOKE, or CREATE OR REPLACE so a foreign/partial state is never repaired or
-- overwritten by this migration.
DO $migration_guard$
DECLARE
    v_namespace_oid OID;
    v_executor_owner OID;
    v_expected_owner OID;
    v_server_major INTEGER :=
        current_setting('server_version_num')::INTEGER / 10000;
    v_expected_table_acl_count INTEGER := CASE
        WHEN v_server_major = 17 THEN 8 ELSE 7
    END;
    v_relation_oid OID := to_regclass(
        'public.sophia_deck_quality_producer_failure_signals'
    );
    v_type_oid OID := to_regtype(
        'public.sophia_deck_quality_producer_failure_signals'
    );
    v_record_oid OID := to_regprocedure(
        'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)'
    );
    v_readiness_oid OID := to_regprocedure(
        'public.sophia_get_deck_quality_producer_failure_readiness()'
    );
    v_resolve_oid OID := to_regprocedure(
        'public.sophia_resolve_deck_quality_producer_failure_signal(text,text,text,text)'
    );
    v_named_routine_count BIGINT;
    v_table_attributes_valid BOOLEAN := false;
    v_table_type_valid BOOLEAN := false;
    v_table_acl_valid BOOLEAN := false;
    v_columns_hash TEXT;
    v_constraints_hash TEXT;
    v_index_valid BOOLEAN := false;
    v_auxiliary_state_valid BOOLEAN := false;
    v_record_attributes_valid BOOLEAN := false;
    v_readiness_attributes_valid BOOLEAN := false;
    v_resolve_attributes_valid BOOLEAN := false;
    v_record_acl_valid BOOLEAN := false;
    v_readiness_acl_valid BOOLEAN := false;
    v_resolve_acl_valid BOOLEAN := false;
    v_record_hash TEXT;
    v_readiness_hash TEXT;
    v_resolve_hash TEXT;
BEGIN
    SELECT namespace.oid
      INTO STRICT v_namespace_oid
      FROM pg_catalog.pg_namespace AS namespace
     WHERE namespace.nspname = 'public';
    SELECT role.oid
      INTO STRICT v_executor_owner
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user;
    SELECT role.oid
      INTO STRICT v_expected_owner
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = 'postgres';

    IF to_regrole('anon') IS NULL
       OR v_server_major NOT IN (15, 16, 17)
       OR to_regrole('authenticated') IS NULL
       OR to_regrole('service_role') IS NULL
       OR v_executor_owner <> v_expected_owner
       OR v_expected_owner = ANY (ARRAY[
           to_regrole('anon'), to_regrole('authenticated'),
           to_regrole('service_role')
       ]::OID[])
    THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_signal_environment_invalid'
            USING ERRCODE = '55000';
    END IF;

    SELECT count(*)
      INTO v_named_routine_count
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.pronamespace = v_namespace_oid
       AND procedure.proname = ANY (ARRAY[
           'sophia_record_deck_quality_producer_failure_signal',
           'sophia_get_deck_quality_producer_failure_readiness',
           'sophia_resolve_deck_quality_producer_failure_signal'
       ]::TEXT[]);

    IF v_relation_oid IS NULL THEN
        IF v_type_oid IS NOT NULL OR v_named_routine_count <> 0 THEN
            RAISE EXCEPTION
                'deck_quality_producer_failure_signal_unknown_fingerprint'
                USING ERRCODE = '55000';
        END IF;
        RETURN;
    END IF;

    -- Hold the table stable from the first catalog inspection through the
    -- idempotent DDL below.  Dynamic SQL keeps the empty-state branch valid.
    EXECUTE
        'LOCK TABLE public.sophia_deck_quality_producer_failure_signals '
        'IN ACCESS EXCLUSIVE MODE';

    IF v_type_oid IS NULL
       OR v_record_oid IS NULL
       OR v_readiness_oid IS NULL
       OR v_resolve_oid IS NULL
       OR v_named_routine_count <> 3
    THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_signal_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;

    SELECT relation.relkind = 'r'
           AND relation.relpersistence = 'p'
           AND relation.relowner = v_expected_owner
           AND relation.relam = (
               SELECT access_method.oid
                 FROM pg_catalog.pg_am AS access_method
                WHERE access_method.amname = 'heap'
           )
           AND relation.reltype = v_type_oid
           AND relation.reloftype = 0
           AND relation.relnatts = 15
           AND relation.relchecks = 8
           AND relation.relhasindex
           AND NOT relation.relhasrules
           AND NOT relation.relhastriggers
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
           AND NOT relation.relispartition
           AND relation.relpartbound IS NULL
           AND relation.relreplident = 'd'
           AND relation.reltablespace = 0
           AND relation.reloptions IS NULL
           AND relation.relacl IS NOT NULL
           AND pg_catalog.obj_description(
               relation.oid, 'pg_class'
           ) = 'dq1-producer-failure-signals/v1:2026-07-18'
      INTO v_table_attributes_valid
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = v_relation_oid;

    SELECT type.typtype = 'c'
           AND type.typcategory = 'C'
           AND NOT type.typispreferred
           AND type.typisdefined
           AND type.typrelid = v_relation_oid
           AND type.typowner = v_expected_owner
           AND type.typreceive = 'record_recv'::REGPROC
           AND type.typsend = 'record_send'::REGPROC
           AND type.typacl IS NULL
      INTO v_table_type_valid
      FROM pg_catalog.pg_type AS type
     WHERE type.oid = v_type_oid;

    SELECT count(*) = v_expected_table_acl_count
           AND count(*) FILTER (
               WHERE acl.grantee = v_expected_owner
                 AND acl.grantor = v_expected_owner
                 AND NOT acl.is_grantable
                 AND acl.privilege_type = ANY (ARRAY[
                     'INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE',
                     'REFERENCES', 'TRIGGER', 'MAINTAIN'
                 ]::TEXT[])
           ) = v_expected_table_acl_count
      INTO v_table_acl_valid
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
     WHERE relation.oid = v_relation_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_array(
                               attribute.attnum,
                               attribute.attname,
                               pg_catalog.format_type(
                                   attribute.atttypid, attribute.atttypmod
                               ),
                               attribute.attnotnull,
                               attribute.atthasdef,
                               pg_catalog.pg_get_expr(
                                   default_value.adbin,
                                   default_value.adrelid,
                                   false
                               ),
                               CASE
                                   WHEN attribute.attcollation = 0 THEN '-'
                                   ELSE collation_namespace.nspname || '.'
                                        || collation_catalog.collname
                               END,
                               attribute.attstorage::INTEGER,
                               attribute.attcompression::INTEGER,
                               attribute.attidentity::INTEGER,
                               attribute.attgenerated::INTEGER,
                               COALESCE(attribute.attstattarget, -1),
                               attribute.attndims,
                               attribute.attinhcount,
                               attribute.attislocal,
                               attribute.attisdropped,
                               attribute.attacl,
                               attribute.attoptions,
                               attribute.attfdwoptions,
                               attribute.attmissingval
                           ) ORDER BY attribute.attnum
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_columns_hash
      FROM pg_catalog.pg_attribute AS attribute
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      LEFT JOIN pg_catalog.pg_collation AS collation_catalog
        ON collation_catalog.oid = attribute.attcollation
      LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
        ON collation_namespace.oid = collation_catalog.collnamespace
     WHERE attribute.attrelid = v_relation_oid
       AND attribute.attnum > 0;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_array(
                               constraint_definition.conname,
                               constraint_definition.contype::INTEGER,
                               constraint_definition.condeferrable,
                               constraint_definition.condeferred,
                               constraint_definition.convalidated,
                               constraint_definition.conislocal,
                               constraint_definition.coninhcount,
                               constraint_definition.connoinherit,
                               constraint_definition.conparentid,
                               constraint_definition.conkey::TEXT,
                               pg_catalog.pg_get_constraintdef(
                                   constraint_definition.oid, false
                               )
                           ) ORDER BY constraint_definition.conname
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_constraints_hash
      FROM pg_catalog.pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = v_relation_oid;

    SELECT count(*) = 1
           AND count(*) FILTER (
               WHERE index_relation.relname =
                     'sophia_dq_producer_failure_signals_pkey'
                 AND index_relation.relkind = 'i'
                 AND index_relation.relpersistence = 'p'
                 AND index_relation.relowner = v_expected_owner
                 AND index_relation.relam = (
                     SELECT access_method.oid
                       FROM pg_catalog.pg_am AS access_method
                      WHERE access_method.amname = 'btree'
                 )
                 AND index_relation.reltablespace = 0
                 AND index_relation.reloptions IS NULL
                 AND index_relation.relacl IS NULL
                 AND pg_catalog.obj_description(
                     index_relation.oid, 'pg_class'
                 ) IS NULL
                 AND index_definition.indisunique
                 AND index_definition.indisprimary
                 AND NOT index_definition.indisexclusion
                 AND index_definition.indimmediate
                 AND NOT index_definition.indisclustered
                 AND index_definition.indisvalid
                 AND index_definition.indisready
                 AND index_definition.indislive
                 AND NOT index_definition.indisreplident
                 AND index_definition.indnatts = 1
                 AND index_definition.indnkeyatts = 1
                 AND index_definition.indkey::TEXT = '1'
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indcollation::OID[]
                     )
                 ) = ARRAY[
                     'default'::REGCOLLATION::OID
                 ]
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indclass::OID[]
                     )
                 ) = ARRAY[
                     (
                         SELECT operator_class.oid
                           FROM pg_catalog.pg_opclass AS operator_class
                           JOIN pg_catalog.pg_am AS access_method
                             ON access_method.oid = operator_class.opcmethod
                          WHERE operator_class.opcnamespace =
                                'pg_catalog'::REGNAMESPACE
                            AND operator_class.opcname = 'text_ops'
                            AND access_method.amname = 'btree'
                     )
                 ]
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indoption::SMALLINT[]
                     )
                 ) = ARRAY[0]::SMALLINT[]
                 AND index_definition.indexprs IS NULL
                 AND index_definition.indpred IS NULL
           ) = 1
      INTO v_index_valid
      FROM pg_catalog.pg_index AS index_definition
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_definition.indexrelid
     WHERE index_definition.indrelid = v_relation_oid;

    SELECT NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_policy AS policy
                WHERE policy.polrelid = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_trigger AS trigger
                WHERE trigger.tgrelid = v_relation_oid
                  AND NOT trigger.tgisinternal
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_rewrite AS rule
                WHERE rule.ev_class = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_inherits AS inheritance
                WHERE inheritance.inhrelid = v_relation_oid
                   OR inheritance.inhparent = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_publication_rel AS publication
                WHERE publication.prrelid = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_description AS description
                WHERE description.classoid = 'pg_class'::REGCLASS
                  AND description.objoid = v_relation_oid
                  AND description.objsubid > 0
           )
      INTO v_auxiliary_state_valid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(procedure.prosrc, 'UTF8')
               ),
               'hex'
           ),
           procedure.proowner = v_expected_owner
           AND language.lanname = 'plpgsql'
           AND procedure.provolatile = 'v'
           AND NOT procedure.proisstrict
           AND procedure.prosecdef
           AND NOT procedure.proleakproof
           AND procedure.proparallel = 'u'
           AND procedure.prokind = 'f'
           AND procedure.proretset
           AND procedure.prorettype = 'record'::REGTYPE
           AND procedure.pronargs = 9
           AND procedure.pronargdefaults = 0
           AND procedure.proargdefaults IS NULL
           AND procedure.provariadic = 0
           AND ARRAY(
               SELECT pg_catalog.unnest(procedure.proargtypes::OID[])
           ) = ARRAY[
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID
           ]
           AND procedure.proallargtypes = ARRAY[
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'bigint'::REGTYPE::OID, 'bigint'::REGTYPE::OID,
               'bigint'::REGTYPE::OID, 'timestamptz'::REGTYPE::OID
           ]
           AND procedure.proargmodes::TEXT[] = ARRAY[
               'i', 'i', 'i', 'i', 'i', 'i', 'i', 'i', 'i',
               't', 't', 't', 't', 't', 't', 't'
           ]::TEXT[]
           AND procedure.proargnames = ARRAY[
               'p_schema_version', 'p_campaign_id', 'p_candidate_digest',
               'p_user_id', 'p_failure_code', 'p_failure_stage',
               'p_upstream_failure_code', 'p_quality_run_id',
               'p_signal_hash', 'outcome', 'candidate_digest',
               'signal_hash', 'persisted_count', 'unresolved_count',
               'conflict_count', 'oldest_unresolved_at'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
           AND procedure.procost = 100
           AND procedure.prorows = 1000
           AND procedure.prosupport = 0
           AND procedure.protrftypes IS NULL
           AND procedure.probin IS NULL
           AND procedure.prosqlbody IS NULL
           AND procedure.proacl IS NOT NULL
           AND pg_catalog.obj_description(
               procedure.oid, 'pg_proc'
           ) IS NULL
      INTO v_record_hash, v_record_attributes_valid
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
     WHERE procedure.oid = v_record_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(procedure.prosrc, 'UTF8')
               ),
               'hex'
           ),
           procedure.proowner = v_expected_owner
           AND language.lanname = 'sql'
           AND procedure.provolatile = 's'
           AND NOT procedure.proisstrict
           AND procedure.prosecdef
           AND NOT procedure.proleakproof
           AND procedure.proparallel = 'u'
           AND procedure.prokind = 'f'
           AND procedure.proretset
           AND procedure.prorettype = 'record'::REGTYPE
           AND procedure.pronargs = 0
           AND procedure.pronargdefaults = 0
           AND procedure.proargdefaults IS NULL
           AND procedure.provariadic = 0
           AND ARRAY(
               SELECT pg_catalog.unnest(procedure.proargtypes::OID[])
           ) = ARRAY[]::OID[]
           AND procedure.proallargtypes = ARRAY[
               'bigint'::REGTYPE::OID, 'bigint'::REGTYPE::OID,
               'bigint'::REGTYPE::OID, 'timestamptz'::REGTYPE::OID
           ]
           AND procedure.proargmodes::TEXT[] = ARRAY[
               't', 't', 't', 't'
           ]::TEXT[]
           AND procedure.proargnames = ARRAY[
               'persisted_count', 'unresolved_count', 'conflict_count',
               'oldest_unresolved_at'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
           AND procedure.procost = 100
           AND procedure.prorows = 1000
           AND procedure.prosupport = 0
           AND procedure.protrftypes IS NULL
           AND procedure.probin IS NULL
           AND procedure.prosqlbody IS NULL
           AND procedure.proacl IS NOT NULL
           AND pg_catalog.obj_description(
               procedure.oid, 'pg_proc'
           ) IS NULL
      INTO v_readiness_hash, v_readiness_attributes_valid
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
     WHERE procedure.oid = v_readiness_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(procedure.prosrc, 'UTF8')
               ),
               'hex'
           ),
           procedure.proowner = v_expected_owner
           AND language.lanname = 'plpgsql'
           AND procedure.provolatile = 'v'
           AND NOT procedure.proisstrict
           AND procedure.prosecdef
           AND NOT procedure.proleakproof
           AND procedure.proparallel = 'u'
           AND procedure.prokind = 'f'
           AND procedure.proretset
           AND procedure.prorettype = 'record'::REGTYPE
           AND procedure.pronargs = 4
           AND procedure.pronargdefaults = 0
           AND procedure.proargdefaults IS NULL
           AND procedure.provariadic = 0
           AND ARRAY(
               SELECT pg_catalog.unnest(procedure.proargtypes::OID[])
           ) = ARRAY[
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID
           ]
           AND procedure.proallargtypes = ARRAY[
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'text'::REGTYPE::OID, 'text'::REGTYPE::OID,
               'bigint'::REGTYPE::OID, 'bigint'::REGTYPE::OID,
               'bigint'::REGTYPE::OID, 'timestamptz'::REGTYPE::OID
           ]
           AND procedure.proargmodes::TEXT[] = ARRAY[
               'i', 'i', 'i', 'i', 't', 't', 't', 't'
           ]::TEXT[]
           AND procedure.proargnames = ARRAY[
               'p_candidate_digest', 'p_expected_signal_hash',
               'p_resolution_code', 'p_resolution_hash',
               'persisted_count', 'unresolved_count', 'conflict_count',
               'oldest_unresolved_at'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
           AND procedure.procost = 100
           AND procedure.prorows = 1000
           AND procedure.prosupport = 0
           AND procedure.protrftypes IS NULL
           AND procedure.probin IS NULL
           AND procedure.prosqlbody IS NULL
           AND procedure.proacl IS NOT NULL
           AND pg_catalog.obj_description(
               procedure.oid, 'pg_proc'
           ) IS NULL
      INTO v_resolve_hash, v_resolve_attributes_valid
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_language AS language
        ON language.oid = procedure.prolang
     WHERE procedure.oid = v_resolve_oid;

    SELECT count(*) = 2
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = to_regrole('service_role')
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
      INTO v_record_acl_valid
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
     WHERE procedure.oid = v_record_oid;

    SELECT count(*) = 2
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = to_regrole('service_role')
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
      INTO v_readiness_acl_valid
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
     WHERE procedure.oid = v_readiness_oid;

    SELECT count(*) = 2
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = to_regrole('service_role')
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
      INTO v_resolve_acl_valid
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
     WHERE procedure.oid = v_resolve_oid;

    -- SHA-256(prosrc) values below fingerprint the immutable definitions
    -- installed by this file.  All mutable security attributes are checked
    -- independently so a body-preserving privilege change is also rejected.
    IF NOT v_table_attributes_valid
       OR NOT v_table_type_valid
       OR NOT v_table_acl_valid
       OR v_columns_hash <>
          '4fb4251c38655d0139ba3d3a75ba7db1aa657e5c1c274c9395945bebf147c0a2'
       OR v_constraints_hash <>
          '2f1cd1671dd620f82f2d9abcbde720e388a54643769bb3ad4c623ceee8ee101f'
       OR NOT v_index_valid
       OR NOT v_auxiliary_state_valid
       OR NOT v_record_attributes_valid
       OR v_record_hash <>
          '7eb65884e416b97c64530fdd01e263c1839fe6fe952dafcd7596e969ed242cb1'
       OR NOT v_record_acl_valid
       OR NOT v_readiness_attributes_valid
       OR v_readiness_hash <>
          '153d835eb5a88673f2de06650781732d132a13f071bb743ad83a16a337b2717d'
       OR NOT v_readiness_acl_valid
       OR NOT v_resolve_attributes_valid
       OR v_resolve_hash <>
          '7713f62ea2b6cba5241905c1e845acf0aecaae89687dfcad4d29677f1f8d6967'
       OR NOT v_resolve_acl_valid
    THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_signal_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;
END
$migration_guard$;

CREATE TABLE IF NOT EXISTS public.sophia_deck_quality_producer_failure_signals (
    candidate_digest TEXT,
    signal_hash TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    failure_code TEXT NOT NULL,
    failure_stage TEXT NOT NULL,
    upstream_failure_code TEXT NOT NULL,
    quality_run_id TEXT,
    first_observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    conflict_count INTEGER NOT NULL DEFAULT 0,
    conflict_detected_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolution_code TEXT,
    resolution_hash TEXT,
    CONSTRAINT sophia_dq_producer_failure_signals_pkey PRIMARY KEY (
        candidate_digest
    ),
    CONSTRAINT sophia_dq_producer_failure_candidate_digest_valid CHECK (
        candidate_digest ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT sophia_dq_producer_failure_signal_hash_valid CHECK (
        signal_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT sophia_dq_producer_failure_protocol_locked CHECK (
        schema_version = 'deck-quality-producer-failure-signal/v1'
        AND campaign_id = 'DQ-1'
        AND failure_code = 'shadow_dispatch_unavailable'
    ),
    CONSTRAINT sophia_dq_producer_failure_user_valid CHECK (
        length(user_id) BETWEEN 1 AND 256
        AND user_id = btrim(user_id)
    ),
    CONSTRAINT sophia_dq_producer_failure_stage_code_valid CHECK (
        (failure_stage = 'candidate_metadata'
         AND upstream_failure_code = 'candidate_metadata_invalid')
        OR (failure_stage = 'instrument'
            AND upstream_failure_code = 'instrument_invalid')
        OR (failure_stage = 'producer_bundle'
            AND upstream_failure_code = 'producer_bundle_unavailable')
    ),
    CONSTRAINT sophia_dq_producer_failure_quality_run_valid CHECK (
        quality_run_id IS NULL
        OR quality_run_id ~ '^quality_[0-9a-f]{64}$'
    ),
    CONSTRAINT sophia_dq_producer_failure_conflict_state_valid CHECK (
        conflict_count >= 0
        AND ((conflict_count = 0 AND conflict_detected_at IS NULL)
             OR (conflict_count > 0 AND conflict_detected_at IS NOT NULL))
    ),
    CONSTRAINT sophia_dq_producer_failure_resolution_valid CHECK (
        (resolved_at IS NULL
         AND resolution_code IS NULL
         AND resolution_hash IS NULL)
        OR (resolved_at IS NOT NULL
            AND resolution_code IN (
                'canonical_recovery_verified',
                'operator_acknowledged'
            )
            AND resolution_hash ~ '^[0-9a-f]{64}$')
    )
);

COMMENT ON TABLE public.sophia_deck_quality_producer_failure_signals IS
    'dq1-producer-failure-signals/v1:2026-07-18';

ALTER TABLE public.sophia_deck_quality_producer_failure_signals
    OWNER TO postgres;

ALTER TABLE public.sophia_deck_quality_producer_failure_signals
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sophia_deck_quality_producer_failure_signals
    FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    public.sophia_deck_quality_producer_failure_signals
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sophia_record_deck_quality_producer_failure_signal(
    p_schema_version TEXT,
    p_campaign_id TEXT,
    p_candidate_digest TEXT,
    p_user_id TEXT,
    p_failure_code TEXT,
    p_failure_stage TEXT,
    p_upstream_failure_code TEXT,
    p_quality_run_id TEXT,
    p_signal_hash TEXT
)
RETURNS TABLE (
    outcome TEXT,
    candidate_digest TEXT,
    signal_hash TEXT,
    persisted_count BIGINT,
    unresolved_count BIGINT,
    conflict_count BIGINT,
    oldest_unresolved_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expected_hash TEXT;
    v_inserted INTEGER;
    v_outcome TEXT;
    v_record public.sophia_deck_quality_producer_failure_signals%ROWTYPE;
BEGIN
    v_expected_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                p_schema_version || pg_catalog.chr(31)
                || p_campaign_id || pg_catalog.chr(31)
                || p_candidate_digest || pg_catalog.chr(31)
                || p_user_id || pg_catalog.chr(31)
                || p_failure_code || pg_catalog.chr(31)
                || p_failure_stage || pg_catalog.chr(31)
                || p_upstream_failure_code || pg_catalog.chr(31)
                || COALESCE(p_quality_run_id, ''),
                'UTF8'
            )
        ),
        'hex'
    );
    IF p_signal_hash IS DISTINCT FROM v_expected_hash THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_signal_hash_invalid'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.sophia_deck_quality_producer_failure_signals (
        candidate_digest,
        signal_hash,
        schema_version,
        campaign_id,
        user_id,
        failure_code,
        failure_stage,
        upstream_failure_code,
        quality_run_id
    ) VALUES (
        p_candidate_digest,
        p_signal_hash,
        p_schema_version,
        p_campaign_id,
        p_user_id,
        p_failure_code,
        p_failure_stage,
        p_upstream_failure_code,
        p_quality_run_id
    )
    ON CONFLICT ON CONSTRAINT sophia_dq_producer_failure_signals_pkey
    DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    SELECT signal.*
      INTO STRICT v_record
      FROM public.sophia_deck_quality_producer_failure_signals AS signal
     WHERE signal.candidate_digest = p_candidate_digest
     FOR UPDATE;

    IF v_inserted = 1 THEN
        v_outcome := 'created';
    ELSIF v_record.signal_hash = p_signal_hash THEN
        v_outcome := 'replayed';
    ELSE
        UPDATE public.sophia_deck_quality_producer_failure_signals AS signal
           SET conflict_count = signal.conflict_count + 1,
               conflict_detected_at = clock_timestamp(),
               resolved_at = NULL,
               resolution_code = NULL,
               resolution_hash = NULL
         WHERE signal.candidate_digest = p_candidate_digest
         RETURNING signal.* INTO STRICT v_record;
        v_outcome := 'conflict';
    END IF;

    RETURN QUERY
    SELECT v_outcome,
           v_record.candidate_digest,
           v_record.signal_hash,
           count(*)::BIGINT,
           count(*) FILTER (WHERE signal.resolved_at IS NULL)::BIGINT,
           COALESCE(sum(signal.conflict_count), 0)::BIGINT,
           min(signal.first_observed_at)
               FILTER (WHERE signal.resolved_at IS NULL)
      FROM public.sophia_deck_quality_producer_failure_signals AS signal;
END
$$;

CREATE OR REPLACE FUNCTION public.sophia_get_deck_quality_producer_failure_readiness()
RETURNS TABLE (
    persisted_count BIGINT,
    unresolved_count BIGINT,
    conflict_count BIGINT,
    oldest_unresolved_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT count(*)::BIGINT,
           count(*) FILTER (WHERE signal.resolved_at IS NULL)::BIGINT,
           COALESCE(sum(signal.conflict_count), 0)::BIGINT,
           min(signal.first_observed_at)
               FILTER (WHERE signal.resolved_at IS NULL)
      FROM public.sophia_deck_quality_producer_failure_signals AS signal
$$;

CREATE OR REPLACE FUNCTION public.sophia_resolve_deck_quality_producer_failure_signal(
    p_candidate_digest TEXT,
    p_expected_signal_hash TEXT,
    p_resolution_code TEXT,
    p_resolution_hash TEXT
)
RETURNS TABLE (
    persisted_count BIGINT,
    unresolved_count BIGINT,
    conflict_count BIGINT,
    oldest_unresolved_at TIMESTAMPTZ
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_expected_resolution_hash TEXT;
    v_record public.sophia_deck_quality_producer_failure_signals%ROWTYPE;
BEGIN
    IF p_resolution_code NOT IN (
        'canonical_recovery_verified',
        'operator_acknowledged'
    ) THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_resolution_invalid'
            USING ERRCODE = '22023';
    END IF;
    v_expected_resolution_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                p_candidate_digest || pg_catalog.chr(31)
                || p_expected_signal_hash || pg_catalog.chr(31)
                || p_resolution_code,
                'UTF8'
            )
        ),
        'hex'
    );
    IF p_resolution_hash IS DISTINCT FROM v_expected_resolution_hash THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_resolution_hash_invalid'
            USING ERRCODE = '22023';
    END IF;

    SELECT signal.*
      INTO STRICT v_record
      FROM public.sophia_deck_quality_producer_failure_signals AS signal
     WHERE signal.candidate_digest = p_candidate_digest
     FOR UPDATE;
    IF v_record.signal_hash IS DISTINCT FROM p_expected_signal_hash THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_resolution_identity_conflict'
            USING ERRCODE = '40001';
    END IF;
    IF v_record.resolved_at IS NOT NULL AND (
        v_record.resolution_code IS DISTINCT FROM p_resolution_code
        OR v_record.resolution_hash IS DISTINCT FROM p_resolution_hash
    ) THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_resolution_conflict'
            USING ERRCODE = '40001';
    END IF;
    IF v_record.resolved_at IS NULL THEN
        UPDATE public.sophia_deck_quality_producer_failure_signals AS signal
           SET resolved_at = clock_timestamp(),
               resolution_code = p_resolution_code,
               resolution_hash = p_resolution_hash
         WHERE signal.candidate_digest = p_candidate_digest;
    END IF;

    RETURN QUERY
    SELECT count(*)::BIGINT,
           count(*) FILTER (WHERE signal.resolved_at IS NULL)::BIGINT,
           COALESCE(sum(signal.conflict_count), 0)::BIGINT,
           min(signal.first_observed_at)
               FILTER (WHERE signal.resolved_at IS NULL)
      FROM public.sophia_deck_quality_producer_failure_signals AS signal;
END
$$;

ALTER FUNCTION
    public.sophia_record_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    ) OWNER TO postgres;
ALTER FUNCTION
    public.sophia_get_deck_quality_producer_failure_readiness()
    OWNER TO postgres;
ALTER FUNCTION
    public.sophia_resolve_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT
    ) OWNER TO postgres;

REVOKE ALL ON FUNCTION
    public.sophia_record_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    )
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
    public.sophia_get_deck_quality_producer_failure_readiness()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
    public.sophia_resolve_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT
    )
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    public.sophia_record_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
    )
    TO service_role;
GRANT EXECUTE ON FUNCTION
    public.sophia_get_deck_quality_producer_failure_readiness()
    TO service_role;
GRANT EXECUTE ON FUNCTION
    public.sophia_resolve_deck_quality_producer_failure_signal(
        TEXT, TEXT, TEXT, TEXT
    )
    TO service_role;

-- Recompute the complete table/type/catalog fingerprint plus the installed
-- routine identities, supported-major definitions, bodies, owners, hardened search_path,
-- SECURITY DEFINER bits, and exact two-principal ACLs before commit.
DO $postflight$
DECLARE
    v_expected_owner OID := to_regrole('postgres');
    v_server_major INTEGER :=
        current_setting('server_version_num')::INTEGER / 10000;
    v_expected_table_acl_count INTEGER := CASE
        WHEN v_server_major = 17 THEN 8 ELSE 7
    END;
    v_record_oid OID := to_regprocedure(
        'public.sophia_record_deck_quality_producer_failure_signal(text,text,text,text,text,text,text,text,text)'
    );
    v_readiness_oid OID := to_regprocedure(
        'public.sophia_get_deck_quality_producer_failure_readiness()'
    );
    v_resolve_oid OID := to_regprocedure(
        'public.sophia_resolve_deck_quality_producer_failure_signal(text,text,text,text)'
    );
    v_relation_oid OID := to_regclass(
        'public.sophia_deck_quality_producer_failure_signals'
    );
    v_type_oid OID := to_regtype(
        'public.sophia_deck_quality_producer_failure_signals'
    );
    v_named_routine_count BIGINT;
    v_table_attributes_valid BOOLEAN := false;
    v_table_type_valid BOOLEAN := false;
    v_table_acl_valid BOOLEAN := false;
    v_columns_hash TEXT;
    v_constraints_hash TEXT;
    v_index_valid BOOLEAN := false;
    v_auxiliary_state_valid BOOLEAN := false;
    v_functions_valid BOOLEAN := false;
BEGIN
    SELECT count(*)
      INTO v_named_routine_count
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.pronamespace = 'public'::REGNAMESPACE
       AND procedure.proname = ANY (ARRAY[
           'sophia_record_deck_quality_producer_failure_signal',
           'sophia_get_deck_quality_producer_failure_readiness',
           'sophia_resolve_deck_quality_producer_failure_signal'
       ]::TEXT[]);

    SELECT relation.relkind = 'r'
           AND relation.relpersistence = 'p'
           AND relation.relowner = v_expected_owner
           AND relation.relam = (
               SELECT access_method.oid
                 FROM pg_catalog.pg_am AS access_method
                WHERE access_method.amname = 'heap'
           )
           AND relation.reltype = v_type_oid
           AND relation.reloftype = 0
           AND relation.relnatts = 15
           AND relation.relchecks = 8
           AND relation.relhasindex
           AND NOT relation.relhasrules
           AND NOT relation.relhastriggers
           AND relation.relrowsecurity
           AND relation.relforcerowsecurity
           AND NOT relation.relispartition
           AND relation.relpartbound IS NULL
           AND relation.relreplident = 'd'
           AND relation.reltablespace = 0
           AND relation.reloptions IS NULL
           AND relation.relacl IS NOT NULL
           AND pg_catalog.obj_description(
               relation.oid, 'pg_class'
           ) = 'dq1-producer-failure-signals/v1:2026-07-18'
      INTO v_table_attributes_valid
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = v_relation_oid;

    SELECT type.typtype = 'c'
           AND type.typcategory = 'C'
           AND NOT type.typispreferred
           AND type.typisdefined
           AND type.typrelid = v_relation_oid
           AND type.typowner = v_expected_owner
           AND type.typreceive = 'record_recv'::REGPROC
           AND type.typsend = 'record_send'::REGPROC
           AND type.typacl IS NULL
      INTO v_table_type_valid
      FROM pg_catalog.pg_type AS type
     WHERE type.oid = v_type_oid;

    SELECT count(*) = v_expected_table_acl_count
           AND count(*) FILTER (
               WHERE acl.grantee = v_expected_owner
                 AND acl.grantor = v_expected_owner
                 AND NOT acl.is_grantable
                 AND acl.privilege_type = ANY (ARRAY[
                     'INSERT', 'SELECT', 'UPDATE', 'DELETE', 'TRUNCATE',
                     'REFERENCES', 'TRIGGER', 'MAINTAIN'
                 ]::TEXT[])
           ) = v_expected_table_acl_count
      INTO v_table_acl_valid
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
     WHERE relation.oid = v_relation_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_array(
                               attribute.attnum,
                               attribute.attname,
                               pg_catalog.format_type(
                                   attribute.atttypid, attribute.atttypmod
                               ),
                               attribute.attnotnull,
                               attribute.atthasdef,
                               pg_catalog.pg_get_expr(
                                   default_value.adbin,
                                   default_value.adrelid,
                                   false
                               ),
                               CASE
                                   WHEN attribute.attcollation = 0 THEN '-'
                                   ELSE collation_namespace.nspname || '.'
                                        || collation_catalog.collname
                               END,
                               attribute.attstorage::INTEGER,
                               attribute.attcompression::INTEGER,
                               attribute.attidentity::INTEGER,
                               attribute.attgenerated::INTEGER,
                               COALESCE(attribute.attstattarget, -1),
                               attribute.attndims,
                               attribute.attinhcount,
                               attribute.attislocal,
                               attribute.attisdropped,
                               attribute.attacl,
                               attribute.attoptions,
                               attribute.attfdwoptions,
                               attribute.attmissingval
                           ) ORDER BY attribute.attnum
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_columns_hash
      FROM pg_catalog.pg_attribute AS attribute
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      LEFT JOIN pg_catalog.pg_collation AS collation_catalog
        ON collation_catalog.oid = attribute.attcollation
      LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
        ON collation_namespace.oid = collation_catalog.collnamespace
     WHERE attribute.attrelid = v_relation_oid
       AND attribute.attnum > 0;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       pg_catalog.jsonb_agg(
                           pg_catalog.jsonb_build_array(
                               constraint_definition.conname,
                               constraint_definition.contype::INTEGER,
                               constraint_definition.condeferrable,
                               constraint_definition.condeferred,
                               constraint_definition.convalidated,
                               constraint_definition.conislocal,
                               constraint_definition.coninhcount,
                               constraint_definition.connoinherit,
                               constraint_definition.conparentid,
                               constraint_definition.conkey::TEXT,
                               pg_catalog.pg_get_constraintdef(
                                   constraint_definition.oid, false
                               )
                           ) ORDER BY constraint_definition.conname
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_constraints_hash
      FROM pg_catalog.pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = v_relation_oid;

    SELECT count(*) = 1
           AND count(*) FILTER (
               WHERE index_relation.relname =
                     'sophia_dq_producer_failure_signals_pkey'
                 AND index_relation.relkind = 'i'
                 AND index_relation.relpersistence = 'p'
                 AND index_relation.relowner = v_expected_owner
                 AND index_relation.relam = (
                     SELECT access_method.oid
                       FROM pg_catalog.pg_am AS access_method
                      WHERE access_method.amname = 'btree'
                 )
                 AND index_relation.reltablespace = 0
                 AND index_relation.reloptions IS NULL
                 AND index_relation.relacl IS NULL
                 AND pg_catalog.obj_description(
                     index_relation.oid, 'pg_class'
                 ) IS NULL
                 AND index_definition.indisunique
                 AND index_definition.indisprimary
                 AND NOT index_definition.indisexclusion
                 AND index_definition.indimmediate
                 AND NOT index_definition.indisclustered
                 AND index_definition.indisvalid
                 AND index_definition.indisready
                 AND index_definition.indislive
                 AND NOT index_definition.indisreplident
                 AND index_definition.indnatts = 1
                 AND index_definition.indnkeyatts = 1
                 AND index_definition.indkey::TEXT = '1'
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indcollation::OID[]
                     )
                 ) = ARRAY[
                     'default'::REGCOLLATION::OID
                 ]
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indclass::OID[]
                     )
                 ) = ARRAY[
                     (
                         SELECT operator_class.oid
                           FROM pg_catalog.pg_opclass AS operator_class
                           JOIN pg_catalog.pg_am AS access_method
                             ON access_method.oid = operator_class.opcmethod
                          WHERE operator_class.opcnamespace =
                                'pg_catalog'::REGNAMESPACE
                            AND operator_class.opcname = 'text_ops'
                            AND access_method.amname = 'btree'
                     )
                 ]
                 AND ARRAY(
                     SELECT pg_catalog.unnest(
                         index_definition.indoption::SMALLINT[]
                     )
                 ) = ARRAY[0]::SMALLINT[]
                 AND index_definition.indexprs IS NULL
                 AND index_definition.indpred IS NULL
           ) = 1
      INTO v_index_valid
      FROM pg_catalog.pg_index AS index_definition
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_definition.indexrelid
     WHERE index_definition.indrelid = v_relation_oid;

    SELECT NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_policy AS policy
                WHERE policy.polrelid = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_trigger AS trigger
                WHERE trigger.tgrelid = v_relation_oid
                  AND NOT trigger.tgisinternal
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_rewrite AS rule
                WHERE rule.ev_class = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_inherits AS inheritance
                WHERE inheritance.inhrelid = v_relation_oid
                   OR inheritance.inhparent = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_publication_rel AS publication
                WHERE publication.prrelid = v_relation_oid
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_description AS description
                WHERE description.classoid = 'pg_class'::REGCLASS
                  AND description.objoid = v_relation_oid
                  AND description.objsubid > 0
           )
      INTO v_auxiliary_state_valid;

    SELECT count(*) = 3
           AND pg_catalog.bool_and(function_state.definition_valid)
           AND pg_catalog.bool_and(function_state.acl_valid)
      INTO v_functions_valid
      FROM (
          SELECT procedure.oid,
                 procedure.proowner = v_expected_owner
                 AND procedure.prosecdef
                 AND procedure.proconfig =
                     ARRAY['search_path=public']::TEXT[]
                 AND pg_catalog.obj_description(
                     procedure.oid, 'pg_proc'
                 ) IS NULL
                 AND CASE procedure.oid
                     WHEN v_record_oid THEN
                         pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 procedure.prosrc, 'UTF8'
                             )),
                             'hex'
                         ) =
                         '7eb65884e416b97c64530fdd01e263c1839fe6fe952dafcd7596e969ed242cb1'
                         AND pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 pg_catalog.pg_get_functiondef(
                                     procedure.oid
                                 ),
                                 'UTF8'
                             )),
                             'hex'
                         ) =
                         '9be3cdd00b3e04629f78bc43a41520755cd3f7aebefed36f60d3fba061e858c3'
                     WHEN v_readiness_oid THEN
                         pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 procedure.prosrc, 'UTF8'
                             )),
                             'hex'
                         ) =
                         '153d835eb5a88673f2de06650781732d132a13f071bb743ad83a16a337b2717d'
                         AND pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 pg_catalog.pg_get_functiondef(
                                     procedure.oid
                                 ),
                                 'UTF8'
                             )),
                             'hex'
                         ) =
                         '6043afc29be0167659a79508a27930ed990d99ba239e439bb60ea627712ed59c'
                     WHEN v_resolve_oid THEN
                         pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 procedure.prosrc, 'UTF8'
                             )),
                             'hex'
                         ) =
                         '7713f62ea2b6cba5241905c1e845acf0aecaae89687dfcad4d29677f1f8d6967'
                         AND pg_catalog.encode(
                             pg_catalog.sha256(pg_catalog.convert_to(
                                 pg_catalog.pg_get_functiondef(
                                     procedure.oid
                                 ),
                                 'UTF8'
                             )),
                             'hex'
                         ) =
                         '29b6eaf440aa4d1b6577dd59cccfa681503934142d952de477509026616e34a8'
                     ELSE false
                 END AS definition_valid,
                 count(*) = 2
                 AND count(*) FILTER (
                     WHERE acl.grantee = procedure.proowner
                       AND acl.grantor = procedure.proowner
                       AND acl.privilege_type = 'EXECUTE'
                       AND NOT acl.is_grantable
                 ) = 1
                 AND count(*) FILTER (
                     WHERE acl.grantee = to_regrole('service_role')
                       AND acl.grantor = procedure.proowner
                       AND acl.privilege_type = 'EXECUTE'
                       AND NOT acl.is_grantable
                 ) = 1 AS acl_valid
            FROM pg_catalog.pg_proc AS procedure
            CROSS JOIN LATERAL pg_catalog.aclexplode(
                procedure.proacl
            ) AS acl
           WHERE procedure.oid = ANY (ARRAY[
               v_record_oid, v_readiness_oid, v_resolve_oid
           ]::OID[])
           GROUP BY procedure.oid
      ) AS function_state;

    IF NOT COALESCE(
        v_named_routine_count = 3
        AND v_table_attributes_valid
        AND v_table_type_valid
        AND v_table_acl_valid
        AND v_columns_hash =
            '4fb4251c38655d0139ba3d3a75ba7db1aa657e5c1c274c9395945bebf147c0a2'
        AND v_constraints_hash =
            '2f1cd1671dd620f82f2d9abcbde720e388a54643769bb3ad4c623ceee8ee101f'
        AND v_index_valid
        AND v_auxiliary_state_valid
        AND v_functions_valid,
        false
    ) THEN
        RAISE EXCEPTION
            'deck_quality_producer_failure_signal_postflight_failed'
            USING ERRCODE = '55000';
    END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
