-- DQ-1 publication request/input convergence.
--
-- The originally deployed publication contract used a hash-addressed producer
-- path and exposed request and input-commit as two service-role RPCs.  This
-- forward-only migration accepts exactly that empty legacy state or the exact
-- converged state, then installs one stable producer path and one atomic RPC.
-- Unknown or mixed function definitions fail before any schema change.

BEGIN;

-- The source-path validator is referenced by table checks and both split RPCs
-- write the publication table.  Hold the strongest table lock while the
-- fingerprint is inspected and all four functions/ACLs converge.
LOCK TABLE public.sophia_deck_quality_publications
    IN ACCESS EXCLUSIVE MODE;

DO $migration_guard$
DECLARE
    v_source_oid OID := to_regprocedure(
        'public.sophia_deck_quality_publication_source_path_valid(text,text,text,text,text,text)'
    );
    v_request_oid OID := to_regprocedure(
        'public.sophia_request_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz)'
    );
    v_commit_oid OID := to_regprocedure(
        'public.sophia_commit_deck_quality_publication_inputs(text,text,text)'
    );
    v_ready_oid OID := to_regprocedure(
        'public.sophia_request_ready_deck_quality_publication(text,text,text,text,text,text,jsonb,text,text,text,text,jsonb,text,text,text,text,text,text,text,text,text,bigint,text,text,integer,timestamptz,integer,timestamptz,text,text)'
    );
    v_source_hash TEXT;
    v_request_hash TEXT;
    v_commit_hash TEXT;
    v_ready_hash TEXT;
    v_source_owner OID;
    v_request_owner OID;
    v_commit_owner OID;
    v_ready_owner OID;
    v_executor_owner OID;
    v_server_major INTEGER :=
        current_setting('server_version_num')::INTEGER / 10000;
    v_source_attributes_valid BOOLEAN := false;
    v_request_attributes_valid BOOLEAN := false;
    v_commit_attributes_valid BOOLEAN := false;
    v_ready_attributes_valid BOOLEAN := false;
    v_source_acl_owner_only BOOLEAN := false;
    v_request_acl_owner_only BOOLEAN := false;
    v_request_acl_owner_service BOOLEAN := false;
    v_commit_acl_owner_only BOOLEAN := false;
    v_commit_acl_owner_service BOOLEAN := false;
    v_ready_acl_owner_service BOOLEAN := false;
    v_table_oid OID :=
        'public.sophia_deck_quality_publications'::REGCLASS;
    v_relation_hash TEXT;
    v_type_hash TEXT;
    v_table_acl_hash TEXT;
    v_columns_hash TEXT;
    v_constraints_hash TEXT;
    v_indexes_hash TEXT;
    v_policies_hash TEXT;
    v_triggers_hash TEXT;
    v_auxiliary_hash TEXT;
    v_named_routine_count BIGINT;
    v_routines_hash TEXT;
    v_table_fingerprint_valid BOOLEAN := false;
    v_is_legacy BOOLEAN := false;
    v_is_v2 BOOLEAN := false;
BEGIN
    SELECT role.oid INTO STRICT v_executor_owner
     FROM pg_roles AS role
     WHERE role.rolname = current_user;

    IF current_user <> 'postgres'
       OR v_server_major NOT IN (15, 16, 17)
       OR to_regrole('anon') IS NULL
       OR to_regrole('authenticated') IS NULL
       OR to_regrole('service_role') IS NULL
       OR (
           SELECT count(DISTINCT role_oid)
             FROM pg_catalog.unnest(ARRAY[
                 to_regrole('postgres'),
                 to_regrole('anon'),
                 to_regrole('authenticated'),
                 to_regrole('service_role')
             ]::OID[]) AS role_oid
       ) <> 4
    THEN
        RAISE EXCEPTION
            'deck_quality_publication_atomic_migration_environment_invalid'
            USING ERRCODE = '55000';
    END IF;

    IF v_source_oid IS NULL OR v_request_oid IS NULL OR v_commit_oid IS NULL THEN
        RAISE EXCEPTION 'deck_quality_publication_atomic_migration_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.jsonb_build_array(
                   relation.relkind::INTEGER,
                   relation.relpersistence::INTEGER,
                   owner_role.rolname,
                   access_method.amname,
                   relation.reloftype = 0,
                   relation.relnatts,
                   relation.relchecks,
                   relation.relhasindex,
                   relation.relhasrules,
                   relation.relhastriggers,
                   relation.relrowsecurity,
                   relation.relforcerowsecurity,
                   relation.relispopulated,
                   relation.relreplident::INTEGER,
                   relation.relispartition,
                   relation.relpartbound IS NULL,
                   tablespace.spcname,
                   relation.reloptions,
                   relation.relacl IS NULL,
                   pg_catalog.obj_description(relation.oid, 'pg_class')
               )::TEXT, 'UTF8')), 'hex')
      INTO v_relation_hash
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = relation.relowner
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = relation.relam
      LEFT JOIN pg_catalog.pg_tablespace AS tablespace
        ON tablespace.oid = relation.reltablespace
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.jsonb_build_array(
                   type.typtype::INTEGER,
                   type.typcategory::INTEGER,
                   type.typispreferred,
                   type.typisdefined,
                   owner_role.rolname,
                   type.typreceive::REGPROC::TEXT,
                   type.typsend::REGPROC::TEXT,
                   type.typnotnull,
                   type.typdefault,
                   type.typacl IS NULL
               )::TEXT, 'UTF8')), 'hex')
      INTO v_type_hash
      FROM pg_catalog.pg_type AS type
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = type.typowner
     WHERE type.oid = (
         SELECT relation.reltype
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = v_table_oid
     );

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_array(
                       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END,
                       pg_catalog.pg_get_userbyid(acl.grantor),
                       acl.privilege_type,
                       acl.is_grantable
                   ) ORDER BY
                       CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                            ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END,
                       pg_catalog.pg_get_userbyid(acl.grantor),
                       acl.privilege_type,
                       acl.is_grantable
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_table_acl_hash
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_array(
                       attribute.attnum,
                       attribute.attname,
                       pg_catalog.format_type(
                           attribute.atttypid, attribute.atttypmod
                       ),
                       attribute.attnotnull,
                       attribute.atthasdef,
                       pg_catalog.pg_get_expr(
                           default_value.adbin, default_value.adrelid, false
                       ),
                       CASE WHEN attribute.attcollation = 0 THEN '-'
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
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_columns_hash
      FROM pg_catalog.pg_attribute AS attribute
      LEFT JOIN pg_catalog.pg_attrdef AS default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
      LEFT JOIN pg_catalog.pg_collation AS collation_catalog
        ON collation_catalog.oid = attribute.attcollation
      LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
        ON collation_namespace.oid = collation_catalog.collnamespace
     WHERE attribute.attrelid = v_table_oid
       AND attribute.attnum > 0;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
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
                       constraint_definition.confkey::TEXT,
                       CASE WHEN constraint_definition.confrelid = 0
                            THEN NULL
                            ELSE constraint_definition.confrelid
                                 ::REGCLASS::TEXT
                       END,
                       constraint_definition.confupdtype::INTEGER,
                       constraint_definition.confdeltype::INTEGER,
                       constraint_definition.confmatchtype::INTEGER,
                       pg_catalog.pg_get_constraintdef(
                           constraint_definition.oid, false
                       )
                   ) ORDER BY constraint_definition.conname
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_constraints_hash
      FROM pg_catalog.pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_array(
                       index_relation.relname,
                       index_relation.relkind::INTEGER,
                       index_relation.relpersistence::INTEGER,
                       owner_role.rolname,
                       access_method.amname,
                       tablespace.spcname,
                       index_relation.reloptions,
                       index_relation.relacl IS NULL,
                       pg_catalog.obj_description(
                           index_relation.oid, 'pg_class'
                       ),
                       index_definition.indisunique,
                       index_definition.indnullsnotdistinct,
                       index_definition.indisprimary,
                       index_definition.indisexclusion,
                       index_definition.indimmediate,
                       index_definition.indisclustered,
                       index_definition.indisvalid,
                       index_definition.indcheckxmin,
                       index_definition.indisready,
                       index_definition.indislive,
                       index_definition.indisreplident,
                       index_definition.indnatts,
                       index_definition.indnkeyatts,
                       index_definition.indkey::TEXT,
                       index_definition.indoption::TEXT,
                       pg_catalog.pg_get_expr(
                           index_definition.indexprs,
                           index_definition.indrelid,
                           false
                       ),
                       pg_catalog.pg_get_expr(
                           index_definition.indpred,
                           index_definition.indrelid,
                           false
                       ),
                       pg_catalog.pg_get_indexdef(
                           index_definition.indexrelid
                       )
                   ) ORDER BY index_relation.relname
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_indexes_hash
      FROM pg_catalog.pg_index AS index_definition
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_definition.indexrelid
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = index_relation.relowner
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
      LEFT JOIN pg_catalog.pg_tablespace AS tablespace
        ON tablespace.oid = index_relation.reltablespace
     WHERE index_definition.indrelid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_array(
                       policy.polname,
                       policy.polcmd::INTEGER,
                       policy.polpermissive,
                       ARRAY(
                           SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC'
                                       ELSE pg_catalog.pg_get_userbyid(role_oid)
                                  END
                             FROM pg_catalog.unnest(
                                 policy.polroles
                             ) AS role_oid
                            ORDER BY 1
                       ),
                       pg_catalog.pg_get_expr(
                           policy.polqual, policy.polrelid, false
                       ),
                       pg_catalog.pg_get_expr(
                           policy.polwithcheck, policy.polrelid, false
                       )
                   ) ORDER BY policy.polname
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_policies_hash
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   pg_catalog.jsonb_build_array(
                       trigger.tgname,
                       trigger.tgfoid::REGPROCEDURE::TEXT,
                       trigger.tgtype,
                       trigger.tgenabled::INTEGER,
                       trigger.tgisinternal,
                       CASE WHEN trigger.tgconstraint = 0 THEN NULL
                            ELSE constraint_definition.conname
                       END,
                       CASE WHEN trigger.tgconstrrelid = 0 THEN NULL
                            ELSE trigger.tgconstrrelid::REGCLASS::TEXT
                       END,
                       trigger.tgdeferrable,
                       trigger.tginitdeferred,
                       trigger.tgnargs,
                       pg_catalog.encode(trigger.tgargs, 'hex'),
                       trigger.tgoldtable,
                       trigger.tgnewtable,
                       pg_catalog.pg_get_triggerdef(trigger.oid, false)
                   ) ORDER BY trigger.tgname
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_triggers_hash
      FROM pg_catalog.pg_trigger AS trigger
      LEFT JOIN pg_catalog.pg_constraint AS constraint_definition
        ON constraint_definition.oid = trigger.tgconstraint
     WHERE trigger.tgrelid = v_table_oid;

    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.jsonb_build_object(
                   'rules', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      rule.rulename,
                                      rule.ev_type::INTEGER,
                                      rule.ev_enabled::INTEGER,
                                      rule.is_instead,
                                      pg_catalog.pg_get_ruledef(rule.oid, false)
                                  ) ORDER BY rule.rulename
                              )
                         FROM pg_catalog.pg_rewrite AS rule
                        WHERE rule.ev_class = v_table_oid
                   ), '[]'::JSONB),
                   'inheritance', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      inheritance.inhrelid::REGCLASS::TEXT,
                                      inheritance.inhparent::REGCLASS::TEXT,
                                      inheritance.inhseqno,
                                      inheritance.inhdetachpending
                                  ) ORDER BY
                                      inheritance.inhrelid::REGCLASS::TEXT,
                                      inheritance.inhparent::REGCLASS::TEXT,
                                      inheritance.inhseqno
                              )
                         FROM pg_catalog.pg_inherits AS inheritance
                        WHERE inheritance.inhrelid = v_table_oid
                           OR inheritance.inhparent = v_table_oid
                   ), '[]'::JSONB),
                   'publications', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      publication.pubname,
                                      publication_relation.prqual,
                                      publication_relation.prattrs::TEXT
                                  ) ORDER BY publication.pubname
                              )
                         FROM pg_catalog.pg_publication_rel
                              AS publication_relation
                         JOIN pg_catalog.pg_publication AS publication
                           ON publication.oid = publication_relation.prpubid
                        WHERE publication_relation.prrelid = v_table_oid
                   ), '[]'::JSONB),
                   'column_descriptions', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      description.objsubid,
                                      description.description
                                  ) ORDER BY description.objsubid
                              )
                         FROM pg_catalog.pg_description AS description
                        WHERE description.classoid = 'pg_class'::REGCLASS
                          AND description.objoid = v_table_oid
                          AND description.objsubid > 0
                   ), '[]'::JSONB)
               )::TEXT, 'UTF8')), 'hex')
      INTO v_auxiliary_hash;

    SELECT encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex'),
           procedure.proowner,
           procedure.prolang = (
               SELECT language.oid FROM pg_language AS language
                WHERE language.lanname = 'sql'
           )
           AND procedure.provolatile = 'i'
           AND procedure.proisstrict
           AND NOT procedure.prosecdef
           AND procedure.prokind = 'f'
           AND NOT procedure.proretset
           AND procedure.prorettype = 'boolean'::regtype
           AND procedure.pronargdefaults = 0
           AND procedure.proargmodes IS NULL
           AND procedure.proargnames = ARRAY[
               'p_object_path', 'p_object_hash', 'p_user_id',
               'p_thread_id', 'p_build_id', 'p_quality_run_id'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
      INTO v_source_hash, v_source_owner, v_source_attributes_valid
      FROM pg_proc AS procedure
     WHERE procedure.oid = v_source_oid;

    SELECT encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex'),
           procedure.proowner,
           procedure.prolang = (
               SELECT language.oid FROM pg_language AS language
                WHERE language.lanname = 'plpgsql'
           )
           AND procedure.provolatile = 'v'
           AND NOT procedure.proisstrict
           AND procedure.prosecdef
           AND procedure.prokind = 'f'
           AND procedure.proretset
           AND procedure.prorettype =
               'public.sophia_deck_quality_publications'::regtype
           AND procedure.pronargdefaults = 0
           AND procedure.proargmodes IS NULL
           AND procedure.proargnames = ARRAY[
               'p_quality_run_id', 'p_campaign_id',
               'p_instrument_schema_version', 'p_instrument_identity_hash',
               'p_rubric_version', 'p_rubric_hash', 'p_prompt_hashes',
               'p_judge_plan_hash', 'p_judge_profile_version',
               'p_evidence_preprocessor_version', 'p_judge_invoker_version',
               'p_assessment_schema_versions', 'p_adjudication_policy_hash',
               'p_user_id', 'p_thread_id', 'p_task_id', 'p_build_id',
               'p_builder_run_id', 'p_parent_builder_trace_id',
               'p_logical_artifact_id', 'p_artifact_version_id',
               'p_manifest_revision', 'p_artifact_object_path',
               'p_artifact_hash', 'p_max_attempts', 'p_deadline_at',
               'p_quality_max_attempts', 'p_quality_run_deadline_at'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
      INTO v_request_hash, v_request_owner, v_request_attributes_valid
      FROM pg_proc AS procedure
     WHERE procedure.oid = v_request_oid;

    SELECT encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex'),
           procedure.proowner,
           procedure.prolang = (
               SELECT language.oid FROM pg_language AS language
                WHERE language.lanname = 'plpgsql'
           )
           AND procedure.provolatile = 'v'
           AND NOT procedure.proisstrict
           AND procedure.prosecdef
           AND procedure.prokind = 'f'
           AND procedure.proretset
           AND procedure.prorettype =
               'public.sophia_deck_quality_publications'::regtype
           AND procedure.pronargdefaults = 0
           AND procedure.proargmodes IS NULL
           AND procedure.proargnames = ARRAY[
               'p_quality_run_id', 'p_source_pack_object_path',
               'p_source_pack_hash'
           ]::TEXT[]
           AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
      INTO v_commit_hash, v_commit_owner, v_commit_attributes_valid
      FROM pg_proc AS procedure
     WHERE procedure.oid = v_commit_oid;

    SELECT count(*) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1
      INTO v_source_acl_owner_only
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
     WHERE procedure.oid = v_source_oid;

    SELECT count(*) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1,
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
           ) = 1
      INTO v_request_acl_owner_only, v_request_acl_owner_service
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
     WHERE procedure.oid = v_request_oid;

    SELECT count(*) = 1
           AND count(*) FILTER (
               WHERE acl.grantee = procedure.proowner
                 AND acl.grantor = procedure.proowner
                 AND acl.privilege_type = 'EXECUTE'
                 AND NOT acl.is_grantable
           ) = 1,
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
           ) = 1
      INTO v_commit_acl_owner_only, v_commit_acl_owner_service
      FROM pg_proc AS procedure
      CROSS JOIN LATERAL aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
      ) AS acl
     WHERE procedure.oid = v_commit_oid;

    IF v_ready_oid IS NOT NULL THEN
        SELECT encode(sha256(convert_to(procedure.prosrc, 'UTF8')), 'hex'),
               procedure.proowner,
               procedure.prolang = (
                   SELECT language.oid FROM pg_language AS language
                    WHERE language.lanname = 'plpgsql'
               )
               AND procedure.provolatile = 'v'
               AND NOT procedure.proisstrict
               AND procedure.prosecdef
               AND procedure.prokind = 'f'
               AND procedure.proretset
               AND procedure.prorettype =
                   'public.sophia_deck_quality_publications'::regtype
               AND procedure.pronargdefaults = 0
               AND procedure.proargmodes IS NULL
               AND procedure.proargnames = ARRAY[
                   'p_quality_run_id', 'p_campaign_id',
                   'p_instrument_schema_version',
                   'p_instrument_identity_hash', 'p_rubric_version',
                   'p_rubric_hash', 'p_prompt_hashes', 'p_judge_plan_hash',
                   'p_judge_profile_version',
                   'p_evidence_preprocessor_version',
                   'p_judge_invoker_version', 'p_assessment_schema_versions',
                   'p_adjudication_policy_hash', 'p_user_id', 'p_thread_id',
                   'p_task_id', 'p_build_id', 'p_builder_run_id',
                   'p_parent_builder_trace_id', 'p_logical_artifact_id',
                   'p_artifact_version_id', 'p_manifest_revision',
                   'p_artifact_object_path', 'p_artifact_hash',
                   'p_max_attempts', 'p_deadline_at',
                   'p_quality_max_attempts', 'p_quality_run_deadline_at',
                   'p_source_pack_object_path', 'p_source_pack_hash'
               ]::TEXT[]
               AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
          INTO v_ready_hash, v_ready_owner, v_ready_attributes_valid
          FROM pg_proc AS procedure
         WHERE procedure.oid = v_ready_oid;

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
          INTO v_ready_acl_owner_service
          FROM pg_proc AS procedure
          CROSS JOIN LATERAL aclexplode(
              COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
          ) AS acl
         WHERE procedure.oid = v_ready_oid;
    END IF;

    -- Normalize every pg_proc field that can contain an OID, then hash the
    -- complete catalog rows, signatures, ACLs, bodies, and deparsed DDL.  The
    -- count makes an otherwise compatible same-name overload fail closed.
    WITH routines AS (
        SELECT procedure.*,
               namespace.nspname AS namespace_name,
               owner_role.rolname AS owner_name,
               language.lanname AS language_name
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = procedure.proowner
          JOIN pg_catalog.pg_language AS language
            ON language.oid = procedure.prolang
         WHERE procedure.pronamespace = 'public'::REGNAMESPACE
           AND procedure.proname = ANY (ARRAY[
               'sophia_deck_quality_publication_source_path_valid',
               'sophia_request_deck_quality_publication',
               'sophia_commit_deck_quality_publication_inputs',
               'sophia_request_ready_deck_quality_publication'
           ]::TEXT[])
    ), canonical AS (
        SELECT procedure.proname,
               pg_catalog.pg_get_function_identity_arguments(
                   procedure.oid
               ) AS identity_arguments,
               (
                   pg_catalog.to_jsonb(procedure)
                   - ARRAY[
                       'oid', 'pronamespace', 'proowner', 'prolang',
                       'prorettype', 'proargtypes', 'proallargtypes',
                       'provariadic', 'prosupport', 'protrftypes', 'proacl',
                       'proargdefaults'
                     ]::TEXT[]
               ) || pg_catalog.jsonb_build_object(
                   'namespace', procedure.namespace_name,
                   'owner', procedure.owner_name,
                   'language', procedure.language_name,
                   'return_type', pg_catalog.format_type(
                       procedure.prorettype, NULL
                   ),
                   'input_types', ARRAY(
                       SELECT pg_catalog.format_type(argument_type, NULL)
                         FROM pg_catalog.unnest(
                             procedure.proargtypes::OID[]
                         ) WITH ORDINALITY
                              AS input_type(argument_type, ordinal)
                        ORDER BY ordinal
                   ),
                   'all_types', CASE
                       WHEN procedure.proallargtypes IS NULL THEN NULL
                       ELSE ARRAY(
                           SELECT pg_catalog.format_type(argument_type, NULL)
                             FROM pg_catalog.unnest(
                                 procedure.proallargtypes
                             ) WITH ORDINALITY
                                  AS all_type(argument_type, ordinal)
                            ORDER BY ordinal
                       )
                   END,
                   'variadic_type', CASE
                       WHEN procedure.provariadic = 0 THEN NULL
                       ELSE pg_catalog.format_type(
                           procedure.provariadic, NULL
                       )
                   END,
                   'support', CASE
                       WHEN procedure.prosupport = 0 THEN NULL
                       ELSE procedure.prosupport::REGPROC::TEXT
                   END,
                   'transform_types', CASE
                       WHEN procedure.protrftypes IS NULL THEN NULL
                       ELSE ARRAY(
                           SELECT pg_catalog.format_type(transform_type, NULL)
                             FROM pg_catalog.unnest(
                                 procedure.protrftypes
                             ) WITH ORDINALITY
                                  AS transform(transform_type, ordinal)
                            ORDER BY ordinal
                       )
                   END,
                   'argdefaults', pg_catalog.pg_get_expr(
                       procedure.proargdefaults, 0, false
                   ),
                   'identity_arguments',
                       pg_catalog.pg_get_function_identity_arguments(
                           procedure.oid
                       ),
                   'arguments', pg_catalog.pg_get_function_arguments(
                       procedure.oid
                   ),
                   'result', pg_catalog.pg_get_function_result(procedure.oid),
                   'acl_is_null', procedure.proacl IS NULL,
                   'acl', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(
                                               acl.grantee
                                           )
                                      END,
                                      pg_catalog.pg_get_userbyid(acl.grantor),
                                      acl.privilege_type,
                                      acl.is_grantable
                                  ) ORDER BY
                                      CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(
                                               acl.grantee
                                           )
                                      END,
                                      pg_catalog.pg_get_userbyid(acl.grantor),
                                      acl.privilege_type,
                                      acl.is_grantable
                              )
                         FROM pg_catalog.aclexplode(procedure.proacl) AS acl
                   ), '[]'::JSONB),
                   'description', pg_catalog.obj_description(
                       procedure.oid, 'pg_proc'
                   ),
                   'prosrc_sha256', pg_catalog.encode(
                       pg_catalog.sha256(pg_catalog.convert_to(
                           procedure.prosrc, 'UTF8'
                       )), 'hex'
                   ),
                   'functiondef_sha256', pg_catalog.encode(
                       pg_catalog.sha256(pg_catalog.convert_to(
                           pg_catalog.pg_get_functiondef(procedure.oid),
                           'UTF8'
                       )), 'hex'
                   )
               ) AS definition
          FROM routines AS procedure
    )
    SELECT count(*),
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   definition ORDER BY proname, identity_arguments
               ), '[]'::JSONB)::TEXT, 'UTF8'
           )), 'hex')
      INTO v_named_routine_count, v_routines_hash
      FROM canonical;

    v_table_fingerprint_valid :=
        v_relation_hash =
            'cc7129153cc85a265e920560063fe632d7f59bfb3dc665af068d876685cb3757'
        AND v_type_hash =
            'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
        AND v_table_acl_hash = CASE v_server_major
            WHEN 17 THEN
                'd588b45201221b60a38b2c4254af121ad1c3c2ce27c50d899c8d47bf8f868795'
            ELSE
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
        END
        AND v_columns_hash =
            '396d5e8ed627d13fc9b02a63357a2c29ced78a2aa6f47ba350f09e608d1a7c18'
        AND v_constraints_hash =
            '76fe211b6b94233fa3f2651b867811ebe43087d31eacc47ff03fbb54c9bc68db'
        AND v_indexes_hash =
            '55bcf4bd3539f941ea689a257d97b4145fd92641ab1025ffb0ac3c34131bd770'
        AND v_policies_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_triggers_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_auxiliary_hash =
            '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec';

    -- These are exact SHA-256(prosrc) fingerprints of the immutable 2026-07-16
    -- legacy definitions and the definitions installed below.  Attributes are
    -- checked separately so a body-preserving SECURITY DEFINER/config change
    -- is also rejected.
    v_is_legacy := v_table_fingerprint_valid
        AND v_named_routine_count = 3
        AND v_routines_hash =
            '6d64b6757765ff52e46c79c05f728948edb06ef00663b78bb0011adc3546ace6'
        AND v_source_attributes_valid
        AND v_source_hash = 'ed3ab9d582ceccf766e3523082108c38aded2cf19c41c399c93eb7ee478acef6'
        AND v_source_acl_owner_only
        AND v_request_attributes_valid
        AND v_request_hash = 'b2a7ac118a4ef5830be233bfd55270b5887d2094dea2890ead1b786d9572484c'
        AND v_request_acl_owner_service
        AND v_commit_attributes_valid
        AND v_commit_hash = 'a207aa72bf2b23ba9c76a4466f1dfb54cc714fc50c71c994f9ca962b01c697ee'
        AND v_commit_acl_owner_service
        AND v_source_owner = v_request_owner
        AND v_source_owner = v_commit_owner
        AND v_source_owner = v_executor_owner
        AND v_source_owner <> ALL (ARRAY[
            to_regrole('anon'), to_regrole('authenticated'),
            to_regrole('service_role')
        ]::OID[])
        AND v_ready_oid IS NULL;

    v_is_v2 := v_table_fingerprint_valid
        AND v_named_routine_count = 4
        AND v_routines_hash =
            '968a2fb40085a5ce0761d0eb5ec589a874a2c1ed5ee7420b5807b23b9efb987e'
        AND v_source_attributes_valid
        AND v_source_hash = '9a068fb761d5bf36dd23516d9a40aa44372bddb96b664e745815ed07517e327d'
        AND v_source_acl_owner_only
        AND v_request_attributes_valid
        AND v_request_hash = 'bc31483a47c8cd4b71c0d6c7d71ffc9cd9041beee79ac68c75e68ed3a18793c0'
        AND v_request_acl_owner_only
        AND v_commit_attributes_valid
        AND v_commit_hash = 'a207aa72bf2b23ba9c76a4466f1dfb54cc714fc50c71c994f9ca962b01c697ee'
        AND v_commit_acl_owner_only
        AND v_ready_attributes_valid
        AND v_ready_hash = '06efeaa941970eb7d86d52043ea5370662120a1970cffb20814d5bd90d1cc663'
        AND v_ready_acl_owner_service
        AND v_source_owner = v_request_owner
        AND v_source_owner = v_commit_owner
        AND v_source_owner = v_ready_owner
        AND v_source_owner = v_executor_owner
        AND v_source_owner <> ALL (ARRAY[
            to_regrole('anon'), to_regrole('authenticated'),
            to_regrole('service_role')
        ]::OID[]);

    IF NOT v_is_legacy AND NOT v_is_v2 THEN
        RAISE EXCEPTION 'deck_quality_publication_atomic_migration_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;

    -- Legacy rows are hash-addressed.  Rewriting their immutable object
    -- identity would require evidence this migration deliberately does not
    -- possess, so the only safe legacy conversion is an empty table.
    IF v_is_legacy AND EXISTS (
        SELECT 1 FROM public.sophia_deck_quality_publications LIMIT 1
    ) THEN
        RAISE EXCEPTION 'deck_quality_publication_atomic_migration_legacy_rows_present'
            USING ERRCODE = '55000';
    END IF;
END;
$migration_guard$;

CREATE OR REPLACE FUNCTION public.sophia_deck_quality_publication_source_path_valid(
    p_object_path TEXT,
    p_object_hash TEXT,
    p_user_id TEXT,
    p_thread_id TEXT,
    p_build_id TEXT,
    p_quality_run_id TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
    SELECT p_object_hash ~ '^[0-9a-f]{64}$'
       AND char_length(p_object_path) <= 4096
       AND p_object_path = replace(
            public.sophia_deck_quality_publication_manifest_path(
                p_user_id, p_thread_id, p_build_id, p_quality_run_id
            ),
            'input_bundle/manifest.json',
            'publication/source_pack/manifest.json'
       );
$$;

-- CREATE OR REPLACE does not revalidate rows that were accepted while an
-- older IMMUTABLE helper was installed.  Recheck every row under the exact
-- stable helper before installing or retaining the atomic SECURITY DEFINER
-- surface.  The legacy branch is necessarily empty; this principally protects
-- nonempty v2 reruns and rejects a mixed function/data state.
DO $existing_rows_guard$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.sophia_deck_quality_publications AS publication
         WHERE publication.quality_run_id !~ '^quality_[0-9a-f]{64}$'
            OR publication.user_id IS DISTINCT FROM
               public.sophia_deck_quality_safe_path_segment(
                   publication.user_id, 'user'
               )
            OR publication.thread_id IS DISTINCT FROM
               public.sophia_deck_quality_safe_path_segment(
                   publication.thread_id, 'thread'
               )
            OR publication.build_id IS DISTINCT FROM
               public.sophia_deck_quality_safe_path_segment(
                   publication.build_id, 'build'
               )
            OR publication.artifact_hash !~ '^[0-9a-f]{64}$'
            OR NOT public.sophia_deck_quality_publication_artifact_path_valid(
                publication.artifact_object_path,
                publication.user_id,
                publication.thread_id
            )
            OR (publication.source_pack_object_path IS NULL) IS DISTINCT FROM
               (publication.source_pack_hash IS NULL)
            OR (
                publication.source_pack_object_path IS NOT NULL
                AND NOT public.sophia_deck_quality_publication_source_path_valid(
                    publication.source_pack_object_path,
                    publication.source_pack_hash,
                    publication.user_id,
                    publication.thread_id,
                    publication.build_id,
                    publication.quality_run_id
                )
            )
            OR (
                publication.state = 'awaiting_inputs'
                AND publication.source_pack_object_path IS NOT NULL
            )
            OR (
                publication.state IN (
                    'pending', 'running', 'retry_wait', 'published'
                )
                AND publication.source_pack_object_path IS NULL
            )
            OR publication.max_attempts <> 3
            OR publication.quality_max_attempts <> 5
            OR NOT isfinite(publication.deadline_at)
            OR NOT isfinite(publication.quality_run_deadline_at)
            OR publication.deadline_at <= publication.requested_at
            OR publication.deadline_at >
               publication.requested_at + interval '3 minutes'
            OR publication.quality_run_deadline_at IS DISTINCT FROM
               publication.deadline_at + interval '12 minutes'
    ) THEN
        RAISE EXCEPTION 'deck_quality_publication_atomic_migration_existing_rows_invalid'
            USING ERRCODE = '55000';
    END IF;
END;
$existing_rows_guard$;

CREATE OR REPLACE FUNCTION public.sophia_request_deck_quality_publication(
    p_quality_run_id TEXT,
    p_campaign_id TEXT,
    p_instrument_schema_version TEXT,
    p_instrument_identity_hash TEXT,
    p_rubric_version TEXT,
    p_rubric_hash TEXT,
    p_prompt_hashes JSONB,
    p_judge_plan_hash TEXT,
    p_judge_profile_version TEXT,
    p_evidence_preprocessor_version TEXT,
    p_judge_invoker_version TEXT,
    p_assessment_schema_versions JSONB,
    p_adjudication_policy_hash TEXT,
    p_user_id TEXT,
    p_thread_id TEXT,
    p_task_id TEXT,
    p_build_id TEXT,
    p_builder_run_id TEXT,
    p_parent_builder_trace_id TEXT,
    p_logical_artifact_id TEXT,
    p_artifact_version_id TEXT,
    p_manifest_revision BIGINT,
    p_artifact_object_path TEXT,
    p_artifact_hash TEXT,
    p_max_attempts INTEGER,
    p_deadline_at TIMESTAMPTZ,
    p_quality_max_attempts INTEGER,
    p_quality_run_deadline_at TIMESTAMPTZ
) RETURNS SETOF public.sophia_deck_quality_publications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_publication public.sophia_deck_quality_publications%ROWTYPE;
BEGIN
    IF p_quality_run_id IS NULL OR p_quality_run_id !~ '^quality_[0-9a-f]{64}$'
       OR p_campaign_id IS NULL OR p_campaign_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$'
       OR p_instrument_schema_version IS NULL OR p_instrument_schema_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR p_instrument_identity_hash IS NULL OR p_instrument_identity_hash !~ '^[0-9a-f]{64}$'
       OR p_rubric_version IS NULL OR p_rubric_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR p_rubric_hash IS NULL OR p_rubric_hash !~ '^[0-9a-f]{64}$'
       OR p_judge_plan_hash IS NULL OR p_judge_plan_hash !~ '^[0-9a-f]{64}$'
       OR p_judge_profile_version IS NULL OR p_judge_profile_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR p_evidence_preprocessor_version IS NULL OR p_evidence_preprocessor_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR p_judge_invoker_version IS NULL OR p_judge_invoker_version !~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'
       OR p_adjudication_policy_hash IS NULL OR p_adjudication_policy_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.sophia_deck_quality_hash_map_valid(p_prompt_hashes)
       OR NOT public.sophia_deck_quality_version_map_valid(p_assessment_schema_versions)
       OR p_user_id IS NULL OR char_length(p_user_id) NOT BETWEEN 1 AND 256
       OR p_user_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_user_id, 'user')
       OR p_thread_id IS NULL OR char_length(p_thread_id) NOT BETWEEN 1 AND 256
       OR p_thread_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_thread_id, 'thread')
       OR p_build_id IS NULL OR p_build_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
       OR p_build_id IS DISTINCT FROM public.sophia_deck_quality_safe_path_segment(p_build_id, 'build')
       OR p_logical_artifact_id IS NULL OR char_length(p_logical_artifact_id) NOT BETWEEN 1 AND 256
       OR p_artifact_version_id IS NULL OR char_length(p_artifact_version_id) NOT BETWEEN 1 AND 256
       OR p_manifest_revision IS NULL OR p_manifest_revision < 1
       OR p_artifact_object_path IS NULL
       OR p_artifact_hash IS NULL OR p_artifact_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.sophia_deck_quality_publication_artifact_path_valid(
            p_artifact_object_path, p_user_id, p_thread_id
       )
       OR p_max_attempts IS DISTINCT FROM 3
       OR p_quality_max_attempts IS DISTINCT FROM 5
       OR p_deadline_at IS NULL OR NOT isfinite(p_deadline_at)
       OR p_quality_run_deadline_at IS NULL OR NOT isfinite(p_quality_run_deadline_at)
       OR p_quality_run_deadline_at IS DISTINCT FROM p_deadline_at + interval '12 minutes' THEN
        RAISE EXCEPTION 'deck_quality_publication_request_invalid' USING ERRCODE = '22023';
    END IF;

    IF (p_task_id IS NOT NULL AND char_length(p_task_id) NOT BETWEEN 1 AND 256)
       OR (p_builder_run_id IS NOT NULL AND char_length(p_builder_run_id) NOT BETWEEN 1 AND 256)
       OR (
           p_parent_builder_trace_id IS NOT NULL
           AND p_parent_builder_trace_id !~ '^[A-Za-z0-9][A-Za-z0-9:_-]{0,255}$'
       ) THEN
        RAISE EXCEPTION 'deck_quality_publication_linkage_invalid' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        p_artifact_version_id || chr(31) || p_campaign_id || chr(31) ||
        p_instrument_identity_hash,
        0
    ));

    SELECT * INTO v_publication
      FROM public.sophia_deck_quality_publications
     WHERE artifact_version_id = p_artifact_version_id
       AND campaign_id = p_campaign_id
       AND instrument_identity_hash = p_instrument_identity_hash
     FOR UPDATE;

    IF FOUND THEN
        IF v_publication.quality_run_id IS DISTINCT FROM p_quality_run_id
           OR v_publication.instrument_schema_version IS DISTINCT FROM p_instrument_schema_version
           OR v_publication.rubric_version IS DISTINCT FROM p_rubric_version
           OR v_publication.rubric_hash IS DISTINCT FROM p_rubric_hash
           OR v_publication.prompt_hashes IS DISTINCT FROM p_prompt_hashes
           OR v_publication.judge_plan_hash IS DISTINCT FROM p_judge_plan_hash
           OR v_publication.judge_profile_version IS DISTINCT FROM p_judge_profile_version
           OR v_publication.evidence_preprocessor_version IS DISTINCT FROM p_evidence_preprocessor_version
           OR v_publication.judge_invoker_version IS DISTINCT FROM p_judge_invoker_version
           OR v_publication.assessment_schema_versions IS DISTINCT FROM p_assessment_schema_versions
           OR v_publication.adjudication_policy_hash IS DISTINCT FROM p_adjudication_policy_hash
           OR v_publication.user_id IS DISTINCT FROM p_user_id
           OR v_publication.thread_id IS DISTINCT FROM p_thread_id
           OR v_publication.task_id IS DISTINCT FROM p_task_id
           OR v_publication.build_id IS DISTINCT FROM p_build_id
           OR v_publication.builder_run_id IS DISTINCT FROM p_builder_run_id
           OR v_publication.parent_builder_trace_id IS DISTINCT FROM p_parent_builder_trace_id
           OR v_publication.logical_artifact_id IS DISTINCT FROM p_logical_artifact_id
           OR v_publication.manifest_revision IS DISTINCT FROM p_manifest_revision
           OR v_publication.artifact_object_path IS DISTINCT FROM p_artifact_object_path
           OR v_publication.artifact_hash IS DISTINCT FROM p_artifact_hash
           OR v_publication.max_attempts IS DISTINCT FROM p_max_attempts
           OR v_publication.quality_max_attempts IS DISTINCT FROM p_quality_max_attempts
        THEN
            RAISE EXCEPTION 'deck_quality_publication_request_identity_conflict' USING ERRCODE = '23505';
        END IF;
        RETURN NEXT v_publication;
        RETURN;
    END IF;

    IF p_deadline_at <= statement_timestamp()
       OR p_deadline_at > statement_timestamp() + interval '3 minutes' THEN
        RAISE EXCEPTION 'deck_quality_publication_deadline_invalid' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.sophia_deck_quality_publications (
        quality_run_id, campaign_id, instrument_schema_version,
        instrument_identity_hash, rubric_version, rubric_hash, prompt_hashes,
        judge_plan_hash, judge_profile_version, evidence_preprocessor_version,
        judge_invoker_version, assessment_schema_versions,
        adjudication_policy_hash, user_id, thread_id, task_id, build_id,
        builder_run_id, parent_builder_trace_id, logical_artifact_id,
        artifact_version_id, manifest_revision, artifact_object_path,
        artifact_hash, max_attempts, deadline_at, quality_max_attempts,
        quality_run_deadline_at
    ) VALUES (
        p_quality_run_id, p_campaign_id, p_instrument_schema_version,
        p_instrument_identity_hash, p_rubric_version, p_rubric_hash,
        p_prompt_hashes, p_judge_plan_hash, p_judge_profile_version,
        p_evidence_preprocessor_version, p_judge_invoker_version,
        p_assessment_schema_versions, p_adjudication_policy_hash, p_user_id,
        p_thread_id, p_task_id, p_build_id, p_builder_run_id,
        p_parent_builder_trace_id, p_logical_artifact_id,
        p_artifact_version_id, p_manifest_revision, p_artifact_object_path,
        p_artifact_hash, p_max_attempts, p_deadline_at,
        p_quality_max_attempts, p_quality_run_deadline_at
    ) RETURNING * INTO v_publication;

    RETURN NEXT v_publication;
END;
$$;

-- The producer bundle is already immutable and verified when this RPC begins.
-- Request creation plus source-pack attachment now shares one transaction; a
-- response-loss replay returns the existing state and preserves its original
-- deadlines and worker progress.
CREATE OR REPLACE FUNCTION public.sophia_request_ready_deck_quality_publication(
    p_quality_run_id TEXT,
    p_campaign_id TEXT,
    p_instrument_schema_version TEXT,
    p_instrument_identity_hash TEXT,
    p_rubric_version TEXT,
    p_rubric_hash TEXT,
    p_prompt_hashes JSONB,
    p_judge_plan_hash TEXT,
    p_judge_profile_version TEXT,
    p_evidence_preprocessor_version TEXT,
    p_judge_invoker_version TEXT,
    p_assessment_schema_versions JSONB,
    p_adjudication_policy_hash TEXT,
    p_user_id TEXT,
    p_thread_id TEXT,
    p_task_id TEXT,
    p_build_id TEXT,
    p_builder_run_id TEXT,
    p_parent_builder_trace_id TEXT,
    p_logical_artifact_id TEXT,
    p_artifact_version_id TEXT,
    p_manifest_revision BIGINT,
    p_artifact_object_path TEXT,
    p_artifact_hash TEXT,
    p_max_attempts INTEGER,
    p_deadline_at TIMESTAMPTZ,
    p_quality_max_attempts INTEGER,
    p_quality_run_deadline_at TIMESTAMPTZ,
    p_source_pack_object_path TEXT,
    p_source_pack_hash TEXT
) RETURNS SETOF public.sophia_deck_quality_publications
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_publication public.sophia_deck_quality_publications%ROWTYPE;
BEGIN
    SELECT * INTO STRICT v_publication
      FROM public.sophia_request_deck_quality_publication(
        p_quality_run_id, p_campaign_id, p_instrument_schema_version,
        p_instrument_identity_hash, p_rubric_version, p_rubric_hash,
        p_prompt_hashes, p_judge_plan_hash, p_judge_profile_version,
        p_evidence_preprocessor_version, p_judge_invoker_version,
        p_assessment_schema_versions, p_adjudication_policy_hash,
        p_user_id, p_thread_id, p_task_id, p_build_id, p_builder_run_id,
        p_parent_builder_trace_id, p_logical_artifact_id,
        p_artifact_version_id, p_manifest_revision,
        p_artifact_object_path, p_artifact_hash, p_max_attempts,
        p_deadline_at, p_quality_max_attempts,
        p_quality_run_deadline_at
      );

    SELECT * INTO STRICT v_publication
      FROM public.sophia_commit_deck_quality_publication_inputs(
        p_quality_run_id,
        p_source_pack_object_path,
        p_source_pack_hash
      );

    RETURN NEXT v_publication;
END;
$$;

REVOKE ALL ON FUNCTION public.sophia_request_deck_quality_publication(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ, INTEGER, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.sophia_commit_deck_quality_publication_inputs(
    TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.sophia_request_ready_deck_quality_publication(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_request_ready_deck_quality_publication(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT, TEXT, JSONB,
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT,
    INTEGER, TIMESTAMPTZ, INTEGER, TIMESTAMPTZ, TEXT, TEXT
) TO service_role;

REVOKE ALL ON FUNCTION public.sophia_deck_quality_publication_source_path_valid(
    TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- A legacy first-apply must prove that the statements above installed the
-- exact v2 catalog state before commit; a later replay is not a repair path.
DO $migration_postflight$
DECLARE
    v_server_major INTEGER :=
        current_setting('server_version_num')::INTEGER / 10000;
    v_relation_hash TEXT;
    v_type_hash TEXT;
    v_table_acl_hash TEXT;
    v_columns_hash TEXT;
    v_constraints_hash TEXT;
    v_indexes_hash TEXT;
    v_policies_hash TEXT;
    v_triggers_hash TEXT;
    v_auxiliary_hash TEXT;
    v_named_routine_count BIGINT;
    v_routines_hash TEXT;
BEGIN
    WITH target AS (
        SELECT relation.*,
               owner_role.rolname AS owner_name,
               access_method.amname,
               tablespace.spcname AS tablespace_name
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = relation.relowner
          LEFT JOIN pg_catalog.pg_am AS access_method
            ON access_method.oid = relation.relam
          LEFT JOIN pg_catalog.pg_tablespace AS tablespace
            ON tablespace.oid = relation.reltablespace
         WHERE relation.oid =
               'public.sophia_deck_quality_publications'::REGCLASS
    ), fingerprints AS (
        SELECT 'relation'::TEXT AS kind,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   pg_catalog.jsonb_build_array(
                       relation.relkind::INTEGER,
                       relation.relpersistence::INTEGER,
                       relation.owner_name,
                       relation.amname,
                       relation.reloftype = 0,
                       relation.relnatts,
                       relation.relchecks,
                       relation.relhasindex,
                       relation.relhasrules,
                       relation.relhastriggers,
                       relation.relrowsecurity,
                       relation.relforcerowsecurity,
                       relation.relispopulated,
                       relation.relreplident::INTEGER,
                       relation.relispartition,
                       relation.relpartbound IS NULL,
                       relation.tablespace_name,
                       relation.reloptions,
                       relation.relacl IS NULL,
                       pg_catalog.obj_description(
                           relation.oid, 'pg_class'
                       )
                   )::TEXT, 'UTF8')), 'hex') AS fingerprint
          FROM target AS relation
        UNION ALL
        SELECT 'type',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   pg_catalog.jsonb_build_array(
                       type.typtype::INTEGER,
                       type.typcategory::INTEGER,
                       type.typispreferred,
                       type.typisdefined,
                       owner_role.rolname,
                       type.typreceive::REGPROC::TEXT,
                       type.typsend::REGPROC::TEXT,
                       type.typnotnull,
                       type.typdefault,
                       type.typacl IS NULL
                   )::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_type AS type
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = type.typowner
         WHERE type.oid = (SELECT reltype FROM target)
        UNION ALL
        SELECT 'table_acl',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
                       pg_catalog.jsonb_build_array(
                           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                           END,
                           pg_catalog.pg_get_userbyid(acl.grantor),
                           acl.privilege_type,
                           acl.is_grantable
                       ) ORDER BY
                           CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                           END,
                           pg_catalog.pg_get_userbyid(acl.grantor),
                           acl.privilege_type,
                           acl.is_grantable
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM target AS relation
          CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
        UNION ALL
        SELECT 'columns',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
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
                           CASE WHEN attribute.attcollation = 0 THEN '-'
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
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_attribute AS attribute
          LEFT JOIN pg_catalog.pg_attrdef AS default_value
            ON default_value.adrelid = attribute.attrelid
           AND default_value.adnum = attribute.attnum
          LEFT JOIN pg_catalog.pg_collation AS collation_catalog
            ON collation_catalog.oid = attribute.attcollation
          LEFT JOIN pg_catalog.pg_namespace AS collation_namespace
            ON collation_namespace.oid = collation_catalog.collnamespace
         WHERE attribute.attrelid = (SELECT oid FROM target)
           AND attribute.attnum > 0
        UNION ALL
        SELECT 'constraints',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
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
                           constraint_definition.confkey::TEXT,
                           CASE WHEN constraint_definition.confrelid = 0
                                THEN NULL
                                ELSE constraint_definition.confrelid
                                     ::REGCLASS::TEXT
                           END,
                           constraint_definition.confupdtype::INTEGER,
                           constraint_definition.confdeltype::INTEGER,
                           constraint_definition.confmatchtype::INTEGER,
                           pg_catalog.pg_get_constraintdef(
                               constraint_definition.oid, false
                           )
                       ) ORDER BY constraint_definition.conname
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_constraint AS constraint_definition
         WHERE constraint_definition.conrelid = (SELECT oid FROM target)
        UNION ALL
        SELECT 'indexes',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
                       pg_catalog.jsonb_build_array(
                           index_relation.relname,
                           index_relation.relkind::INTEGER,
                           index_relation.relpersistence::INTEGER,
                           owner_role.rolname,
                           access_method.amname,
                           tablespace.spcname,
                           index_relation.reloptions,
                           index_relation.relacl IS NULL,
                           pg_catalog.obj_description(
                               index_relation.oid, 'pg_class'
                           ),
                           index_definition.indisunique,
                           index_definition.indnullsnotdistinct,
                           index_definition.indisprimary,
                           index_definition.indisexclusion,
                           index_definition.indimmediate,
                           index_definition.indisclustered,
                           index_definition.indisvalid,
                           index_definition.indcheckxmin,
                           index_definition.indisready,
                           index_definition.indislive,
                           index_definition.indisreplident,
                           index_definition.indnatts,
                           index_definition.indnkeyatts,
                           index_definition.indkey::TEXT,
                           index_definition.indoption::TEXT,
                           pg_catalog.pg_get_expr(
                               index_definition.indexprs,
                               index_definition.indrelid,
                               false
                           ),
                           pg_catalog.pg_get_expr(
                               index_definition.indpred,
                               index_definition.indrelid,
                               false
                           ),
                           pg_catalog.pg_get_indexdef(
                               index_definition.indexrelid
                           )
                       ) ORDER BY index_relation.relname
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_index AS index_definition
          JOIN pg_catalog.pg_class AS index_relation
            ON index_relation.oid = index_definition.indexrelid
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = index_relation.relowner
          LEFT JOIN pg_catalog.pg_am AS access_method
            ON access_method.oid = index_relation.relam
          LEFT JOIN pg_catalog.pg_tablespace AS tablespace
            ON tablespace.oid = index_relation.reltablespace
         WHERE index_definition.indrelid = (SELECT oid FROM target)
        UNION ALL
        SELECT 'policies',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
                       pg_catalog.jsonb_build_array(
                           policy.polname,
                           policy.polcmd::INTEGER,
                           policy.polpermissive,
                           ARRAY(
                               SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(
                                               role_oid
                                           )
                                      END
                                 FROM pg_catalog.unnest(
                                     policy.polroles
                                 ) AS role_oid
                                ORDER BY 1
                           ),
                           pg_catalog.pg_get_expr(
                               policy.polqual, policy.polrelid, false
                           ),
                           pg_catalog.pg_get_expr(
                               policy.polwithcheck, policy.polrelid, false
                           )
                       ) ORDER BY policy.polname
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_policy AS policy
         WHERE policy.polrelid = (SELECT oid FROM target)
        UNION ALL
        SELECT 'triggers',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.jsonb_agg(
                       pg_catalog.jsonb_build_array(
                           trigger.tgname,
                           trigger.tgfoid::REGPROCEDURE::TEXT,
                           trigger.tgtype,
                           trigger.tgenabled::INTEGER,
                           trigger.tgisinternal,
                           CASE WHEN trigger.tgconstraint = 0 THEN NULL
                                ELSE constraint_definition.conname
                           END,
                           CASE WHEN trigger.tgconstrrelid = 0 THEN NULL
                                ELSE trigger.tgconstrrelid::REGCLASS::TEXT
                           END,
                           trigger.tgdeferrable,
                           trigger.tginitdeferred,
                           trigger.tgnargs,
                           pg_catalog.encode(trigger.tgargs, 'hex'),
                           trigger.tgoldtable,
                           trigger.tgnewtable,
                           pg_catalog.pg_get_triggerdef(trigger.oid, false)
                       ) ORDER BY trigger.tgname
                   ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
          FROM pg_catalog.pg_trigger AS trigger
          LEFT JOIN pg_catalog.pg_constraint AS constraint_definition
            ON constraint_definition.oid = trigger.tgconstraint
         WHERE trigger.tgrelid = (SELECT oid FROM target)
        UNION ALL
        SELECT 'auxiliary',
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   pg_catalog.jsonb_build_object(
                       'rules', COALESCE((
                           SELECT pg_catalog.jsonb_agg(
                                      pg_catalog.jsonb_build_array(
                                          rule.rulename,
                                          rule.ev_type::INTEGER,
                                          rule.ev_enabled::INTEGER,
                                          rule.is_instead,
                                          pg_catalog.pg_get_ruledef(
                                              rule.oid, false
                                          )
                                      ) ORDER BY rule.rulename
                                  )
                             FROM pg_catalog.pg_rewrite AS rule
                            WHERE rule.ev_class = (SELECT oid FROM target)
                       ), '[]'::JSONB),
                       'inheritance', COALESCE((
                           SELECT pg_catalog.jsonb_agg(
                                      pg_catalog.jsonb_build_array(
                                          inheritance.inhrelid
                                              ::REGCLASS::TEXT,
                                          inheritance.inhparent
                                              ::REGCLASS::TEXT,
                                          inheritance.inhseqno,
                                          inheritance.inhdetachpending
                                      ) ORDER BY
                                          inheritance.inhrelid
                                              ::REGCLASS::TEXT,
                                          inheritance.inhparent
                                              ::REGCLASS::TEXT,
                                          inheritance.inhseqno
                                  )
                             FROM pg_catalog.pg_inherits AS inheritance
                            WHERE inheritance.inhrelid =
                                  (SELECT oid FROM target)
                               OR inheritance.inhparent =
                                  (SELECT oid FROM target)
                       ), '[]'::JSONB),
                       'publications', COALESCE((
                           SELECT pg_catalog.jsonb_agg(
                                      pg_catalog.jsonb_build_array(
                                          publication.pubname,
                                          publication_relation.prqual,
                                          publication_relation.prattrs::TEXT
                                      ) ORDER BY publication.pubname
                                  )
                             FROM pg_catalog.pg_publication_rel
                                  AS publication_relation
                             JOIN pg_catalog.pg_publication AS publication
                               ON publication.oid =
                                  publication_relation.prpubid
                            WHERE publication_relation.prrelid =
                                  (SELECT oid FROM target)
                       ), '[]'::JSONB),
                       'column_descriptions', COALESCE((
                           SELECT pg_catalog.jsonb_agg(
                                      pg_catalog.jsonb_build_array(
                                          description.objsubid,
                                          description.description
                                      ) ORDER BY description.objsubid
                                  )
                             FROM pg_catalog.pg_description AS description
                            WHERE description.classoid =
                                  'pg_class'::REGCLASS
                              AND description.objoid =
                                  (SELECT oid FROM target)
                              AND description.objsubid > 0
                       ), '[]'::JSONB)
                   )::TEXT, 'UTF8')), 'hex')
    )
    SELECT max(fingerprint) FILTER (WHERE kind = 'relation'),
           max(fingerprint) FILTER (WHERE kind = 'type'),
           max(fingerprint) FILTER (WHERE kind = 'table_acl'),
           max(fingerprint) FILTER (WHERE kind = 'columns'),
           max(fingerprint) FILTER (WHERE kind = 'constraints'),
           max(fingerprint) FILTER (WHERE kind = 'indexes'),
           max(fingerprint) FILTER (WHERE kind = 'policies'),
           max(fingerprint) FILTER (WHERE kind = 'triggers'),
           max(fingerprint) FILTER (WHERE kind = 'auxiliary')
      INTO v_relation_hash,
           v_type_hash,
           v_table_acl_hash,
           v_columns_hash,
           v_constraints_hash,
           v_indexes_hash,
           v_policies_hash,
           v_triggers_hash,
           v_auxiliary_hash
      FROM fingerprints;

    WITH routines AS (
        SELECT procedure.*,
               namespace.nspname AS namespace_name,
               owner_role.rolname AS owner_name,
               language.lanname AS language_name
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = procedure.pronamespace
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = procedure.proowner
          JOIN pg_catalog.pg_language AS language
            ON language.oid = procedure.prolang
         WHERE procedure.pronamespace = 'public'::REGNAMESPACE
           AND procedure.proname = ANY (ARRAY[
               'sophia_deck_quality_publication_source_path_valid',
               'sophia_request_deck_quality_publication',
               'sophia_commit_deck_quality_publication_inputs',
               'sophia_request_ready_deck_quality_publication'
           ]::TEXT[])
    ), canonical AS (
        SELECT procedure.proname,
               pg_catalog.pg_get_function_identity_arguments(
                   procedure.oid
               ) AS identity_arguments,
               (
                   pg_catalog.to_jsonb(procedure)
                   - ARRAY[
                       'oid', 'pronamespace', 'proowner', 'prolang',
                       'prorettype', 'proargtypes', 'proallargtypes',
                       'provariadic', 'prosupport', 'protrftypes', 'proacl',
                       'proargdefaults'
                     ]::TEXT[]
               ) || pg_catalog.jsonb_build_object(
                   'namespace', procedure.namespace_name,
                   'owner', procedure.owner_name,
                   'language', procedure.language_name,
                   'return_type', pg_catalog.format_type(
                       procedure.prorettype, NULL
                   ),
                   'input_types', ARRAY(
                       SELECT pg_catalog.format_type(argument_type, NULL)
                         FROM pg_catalog.unnest(
                             procedure.proargtypes::OID[]
                         ) WITH ORDINALITY
                              AS input_type(argument_type, ordinal)
                        ORDER BY ordinal
                   ),
                   'all_types', CASE
                       WHEN procedure.proallargtypes IS NULL THEN NULL
                       ELSE ARRAY(
                           SELECT pg_catalog.format_type(argument_type, NULL)
                             FROM pg_catalog.unnest(
                                 procedure.proallargtypes
                             ) WITH ORDINALITY
                                  AS all_type(argument_type, ordinal)
                            ORDER BY ordinal
                       )
                   END,
                   'variadic_type', CASE
                       WHEN procedure.provariadic = 0 THEN NULL
                       ELSE pg_catalog.format_type(
                           procedure.provariadic, NULL
                       )
                   END,
                   'support', CASE
                       WHEN procedure.prosupport = 0 THEN NULL
                       ELSE procedure.prosupport::REGPROC::TEXT
                   END,
                   'transform_types', CASE
                       WHEN procedure.protrftypes IS NULL THEN NULL
                       ELSE ARRAY(
                           SELECT pg_catalog.format_type(transform_type, NULL)
                             FROM pg_catalog.unnest(
                                 procedure.protrftypes
                             ) WITH ORDINALITY
                                  AS transform(transform_type, ordinal)
                            ORDER BY ordinal
                       )
                   END,
                   'argdefaults', pg_catalog.pg_get_expr(
                       procedure.proargdefaults, 0, false
                   ),
                   'identity_arguments',
                       pg_catalog.pg_get_function_identity_arguments(
                           procedure.oid
                       ),
                   'arguments', pg_catalog.pg_get_function_arguments(
                       procedure.oid
                   ),
                   'result', pg_catalog.pg_get_function_result(procedure.oid),
                   'acl_is_null', procedure.proacl IS NULL,
                   'acl', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                                  pg_catalog.jsonb_build_array(
                                      CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(
                                               acl.grantee
                                           )
                                      END,
                                      pg_catalog.pg_get_userbyid(acl.grantor),
                                      acl.privilege_type,
                                      acl.is_grantable
                                  ) ORDER BY
                                      CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                           ELSE pg_catalog.pg_get_userbyid(
                                               acl.grantee
                                           )
                                      END,
                                      pg_catalog.pg_get_userbyid(acl.grantor),
                                      acl.privilege_type,
                                      acl.is_grantable
                              )
                         FROM pg_catalog.aclexplode(procedure.proacl) AS acl
                   ), '[]'::JSONB),
                   'description', pg_catalog.obj_description(
                       procedure.oid, 'pg_proc'
                   ),
                   'prosrc_sha256', pg_catalog.encode(
                       pg_catalog.sha256(pg_catalog.convert_to(
                           procedure.prosrc, 'UTF8'
                       )), 'hex'
                   ),
                   'functiondef_sha256', pg_catalog.encode(
                       pg_catalog.sha256(pg_catalog.convert_to(
                           pg_catalog.pg_get_functiondef(procedure.oid),
                           'UTF8'
                       )), 'hex'
                   )
               ) AS definition
          FROM routines AS procedure
    )
    SELECT count(*),
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   definition ORDER BY proname, identity_arguments
               ), '[]'::JSONB)::TEXT, 'UTF8'
           )), 'hex')
      INTO v_named_routine_count, v_routines_hash
      FROM canonical;

    IF NOT COALESCE(
        v_relation_hash =
            'cc7129153cc85a265e920560063fe632d7f59bfb3dc665af068d876685cb3757'
        AND v_type_hash =
            'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
        AND v_table_acl_hash = CASE v_server_major
            WHEN 17 THEN
                'd588b45201221b60a38b2c4254af121ad1c3c2ce27c50d899c8d47bf8f868795'
            ELSE
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
        END
        AND v_columns_hash =
            '396d5e8ed627d13fc9b02a63357a2c29ced78a2aa6f47ba350f09e608d1a7c18'
        AND v_constraints_hash =
            '76fe211b6b94233fa3f2651b867811ebe43087d31eacc47ff03fbb54c9bc68db'
        AND v_indexes_hash =
            '55bcf4bd3539f941ea689a257d97b4145fd92641ab1025ffb0ac3c34131bd770'
        AND v_policies_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_triggers_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_auxiliary_hash =
            '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
        AND v_named_routine_count = 4
        AND v_routines_hash =
            '968a2fb40085a5ce0761d0eb5ec589a874a2c1ed5ee7420b5807b23b9efb987e',
        false
    ) THEN
        RAISE EXCEPTION
            'deck_quality_publication_atomic_migration_postflight_failed'
            USING ERRCODE = '55000';
    END IF;
END
$migration_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
