-- DQ-1 durable trace-grace recovery.
--
-- A shadow run can reach finalizing with an adjudicated result or a failure
-- precursor and then lose its terminal LangSmith trace acknowledgement.  Once
-- the immutable trace grace deadline has elapsed, this service-role-only RPC
-- retires such rows to an honest failed/stale terminal state without changing
-- evidence, adjudication, or dispatch-intent data.

BEGIN;

-- Accept only the exact 07/19 predecessor or an exact replay of the surface
-- below. The table lock keeps the catalog fingerprint stable through DDL and
-- postflight.
DO $migration_guard$
DECLARE
    v_table_oid OID;
    v_expected_owner OID := pg_catalog.to_regrole('postgres');
    v_executor_owner OID := pg_catalog.to_regrole(current_user);
    v_anon OID := pg_catalog.to_regrole('anon');
    v_authenticated OID := pg_catalog.to_regrole('authenticated');
    v_service_role OID := pg_catalog.to_regrole('service_role');
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
    v_dispatch_routine_count BIGINT;
    v_dispatch_routines_hash TEXT;
    v_recovery_oid OID;
    v_named_routine_count BIGINT;
    v_recovery_valid BOOLEAN := false;
BEGIN
    IF v_expected_owner IS NULL
       OR v_server_major NOT IN (15, 16, 17)
       OR v_executor_owner IS DISTINCT FROM v_expected_owner
       OR v_anon IS NULL
       OR v_authenticated IS NULL
       OR v_service_role IS NULL
       OR (
           SELECT count(DISTINCT role_oid)
             FROM pg_catalog.unnest(ARRAY[
                 v_expected_owner, v_anon, v_authenticated, v_service_role
             ]::OID[]) AS role_oid
       ) <> 4
    THEN
        RAISE EXCEPTION
            'deck_quality_trace_grace_recovery_environment_invalid'
            USING ERRCODE = '55000';
    END IF;

    v_table_oid := pg_catalog.to_regclass(
        'public.sophia_deck_quality_shadow_runs'
    );
    IF v_table_oid IS NULL THEN
        RAISE EXCEPTION
            'deck_quality_trace_grace_recovery_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;
    LOCK TABLE public.sophia_deck_quality_shadow_runs
        IN ACCESS EXCLUSIVE MODE;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                           pg_catalog.obj_description(
                               relation.oid, 'pg_class'
                           )
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_relation_hash
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = relation.relowner
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = relation.relam
      LEFT JOIN pg_catalog.pg_tablespace AS tablespace
        ON tablespace.oid = relation.reltablespace
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_type_hash
      FROM pg_catalog.pg_type AS type
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = type.typowner
     WHERE type.oid = (
         SELECT relation.reltype
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = v_table_oid
     );

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_catalog.pg_get_userbyid(
                                            acl.grantee
                                        )
                                   END,
                                   pg_catalog.pg_get_userbyid(acl.grantor),
                                   acl.privilege_type,
                                   acl.is_grantable
                               )
                               ORDER BY
                                   CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_catalog.pg_get_userbyid(
                                            acl.grantee
                                        )
                                   END,
                                   pg_catalog.pg_get_userbyid(acl.grantor),
                                   acl.privilege_type,
                                   acl.is_grantable
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_table_acl_hash
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   attribute.attnum,
                                   attribute.attname,
                                   pg_catalog.format_type(
                                       attribute.atttypid,
                                       attribute.atttypmod
                                   ),
                                   attribute.attnotnull,
                                   attribute.atthasdef,
                                   pg_catalog.pg_get_expr(
                                       default_value.adbin,
                                       default_value.adrelid,
                                       false
                                   ),
                                   CASE WHEN attribute.attcollation = 0
                                        THEN '-'
                                        ELSE collation_namespace.nspname
                                             || '.'
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
                           ),
                           '[]'::JSONB
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
     WHERE attribute.attrelid = v_table_oid
       AND attribute.attnum > 0;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
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
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_constraints_hash
      FROM pg_catalog.pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
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
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
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

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   policy.polname,
                                   policy.polcmd::INTEGER,
                                   policy.polpermissive,
                                   ARRAY(
                                       SELECT CASE WHEN role_oid = 0
                                                   THEN 'PUBLIC'
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
                                       policy.polwithcheck,
                                       policy.polrelid,
                                       false
                                   )
                               ) ORDER BY policy.polname
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_policies_hash
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   trigger.tgname,
                                   trigger.tgfoid::REGPROCEDURE::TEXT,
                                   trigger.tgtype,
                                   trigger.tgenabled::INTEGER,
                                   trigger.tgisinternal,
                                   CASE WHEN trigger.tgconstraint = 0
                                        THEN NULL
                                        ELSE constraint_definition.conname
                                   END,
                                   CASE WHEN trigger.tgconstrrelid = 0
                                        THEN NULL
                                        ELSE trigger.tgconstrrelid
                                             ::REGCLASS::TEXT
                                   END,
                                   trigger.tgdeferrable,
                                   trigger.tginitdeferred,
                                   trigger.tgnargs,
                                   pg_catalog.encode(trigger.tgargs, 'hex'),
                                   trigger.tgoldtable,
                                   trigger.tgnewtable,
                                   pg_catalog.pg_get_triggerdef(
                                       trigger.oid, false
                                   )
                               ) ORDER BY trigger.tgname
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_triggers_hash
      FROM pg_catalog.pg_trigger AS trigger
      LEFT JOIN pg_catalog.pg_constraint AS constraint_definition
        ON constraint_definition.oid = trigger.tgconstraint
     WHERE trigger.tgrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                                WHERE rule.ev_class = v_table_oid
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
                                   ON publication.oid =
                                      publication_relation.prpubid
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
                                WHERE description.classoid =
                                      'pg_class'::REGCLASS
                                  AND description.objoid = v_table_oid
                                  AND description.objsubid > 0
                           ), '[]'::JSONB)
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_auxiliary_hash;

    WITH routines AS (
        SELECT procedure.*,
               owner_role.rolname AS owner_name,
               language.lanname AS language_name
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = procedure.proowner
          JOIN pg_catalog.pg_language AS language
            ON language.oid = procedure.prolang
         WHERE procedure.pronamespace = 'public'::REGNAMESPACE
           AND procedure.proname = ANY (ARRAY[
               'sophia_begin_deck_quality_shadow_dispatch',
               'sophia_resolve_deck_quality_shadow_dispatch',
               'sophia_list_unresolved_deck_quality_shadow_dispatches'
           ]::TEXT[])
    ), canonical AS (
        SELECT procedure.proname,
               pg_catalog.pg_get_function_identity_arguments(
                   procedure.oid
               ) AS identity_arguments,
               pg_catalog.jsonb_build_array(
                   procedure.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                       procedure.oid
                   ),
                   pg_catalog.pg_get_function_arguments(procedure.oid),
                   pg_catalog.pg_get_function_result(procedure.oid),
                   procedure.owner_name,
                   procedure.language_name,
                   procedure.prokind::INTEGER,
                   procedure.provolatile::INTEGER,
                   procedure.proisstrict,
                   procedure.prosecdef,
                   procedure.proleakproof,
                   procedure.proparallel::INTEGER,
                   procedure.proretset,
                   pg_catalog.format_type(procedure.prorettype, NULL),
                   procedure.pronargs,
                   procedure.pronargdefaults,
                   pg_catalog.pg_get_expr(
                       procedure.proargdefaults, 0, false
                   ),
                   CASE WHEN procedure.provariadic = 0 THEN NULL
                        ELSE pg_catalog.format_type(
                            procedure.provariadic, NULL
                        )
                   END,
                   ARRAY(
                       SELECT pg_catalog.format_type(argument_type, NULL)
                         FROM pg_catalog.unnest(
                             procedure.proargtypes::OID[]
                         ) WITH ORDINALITY
                              AS input_type(argument_type, ordinal)
                        ORDER BY ordinal
                   ),
                   CASE WHEN procedure.proallargtypes IS NULL THEN NULL
                        ELSE ARRAY(
                            SELECT pg_catalog.format_type(
                                       argument_type, NULL
                                   )
                              FROM pg_catalog.unnest(
                                  procedure.proallargtypes
                              ) WITH ORDINALITY
                                   AS all_type(argument_type, ordinal)
                             ORDER BY ordinal
                        )
                   END,
                   procedure.proargmodes::TEXT[],
                   procedure.proargnames,
                   procedure.proconfig,
                   procedure.procost,
                   procedure.prorows,
                   CASE WHEN procedure.prosupport = 0 THEN NULL
                        ELSE procedure.prosupport::REGPROC::TEXT
                   END,
                   CASE WHEN procedure.protrftypes IS NULL THEN NULL
                        ELSE ARRAY(
                            SELECT pg_catalog.format_type(
                                       transform_type, NULL
                                   )
                              FROM pg_catalog.unnest(
                                  procedure.protrftypes
                              ) WITH ORDINALITY
                                   AS transform(transform_type, ordinal)
                             ORDER BY ordinal
                        )
                   END,
                   procedure.probin,
                   procedure.prosqlbody::TEXT,
                   procedure.proacl IS NULL,
                   COALESCE((
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
                                  )
                                  ORDER BY
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
                   pg_catalog.obj_description(
                       procedure.oid, 'pg_proc'
                   ),
                   pg_catalog.encode(
                       pg_catalog.sha256(
                           pg_catalog.convert_to(procedure.prosrc, 'UTF8')
                       ),
                       'hex'
                   ),
                   pg_catalog.encode(
                       pg_catalog.sha256(
                           pg_catalog.convert_to(
                               pg_catalog.pg_get_functiondef(procedure.oid),
                               'UTF8'
                           )
                       ),
                       'hex'
                   )
               ) AS definition
          FROM routines AS procedure
    )
    SELECT count(*),
           pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               definition
                               ORDER BY proname, identity_arguments
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_dispatch_routine_count, v_dispatch_routines_hash
      FROM canonical;


    v_recovery_oid := pg_catalog.to_regprocedure(
        'public.sophia_recover_expired_deck_quality_shadow_runs(integer)'
    );
    SELECT count(*)
      INTO v_named_routine_count
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.pronamespace = 'public'::REGNAMESPACE
       AND procedure.proname =
           'sophia_recover_expired_deck_quality_shadow_runs';

    IF v_recovery_oid IS NOT NULL THEN
        SELECT procedure.prokind = 'f'
               AND procedure.proowner = v_expected_owner
               AND procedure.prolang = (
                   SELECT language.oid
                     FROM pg_catalog.pg_language AS language
                    WHERE language.lanname = 'plpgsql'
               )
               AND procedure.procost = 100
               AND procedure.prorows = 0
               AND procedure.provariadic = 0
               AND procedure.prosupport = 0
               AND procedure.prorettype = 'integer'::REGTYPE
               AND NOT procedure.proretset
               AND procedure.provolatile = 'v'
               AND procedure.proparallel = 'u'
               AND procedure.prosecdef
               AND NOT procedure.proleakproof
               AND NOT procedure.proisstrict
               AND procedure.pronargs = 1
               AND procedure.pronargdefaults = 1
               AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
               AND procedure.probin IS NULL
               AND procedure.prosqlbody IS NULL
               AND pg_catalog.obj_description(
                   procedure.oid, 'pg_proc'
               ) IS NULL
               AND pg_catalog.encode(pg_catalog.sha256(
                   pg_catalog.convert_to(procedure.prosrc, 'UTF8')
               ), 'hex') = 'fb1082d007d69721898aa5908c54cbbde5cf498ee965b7a111353c389928c711'
               AND (
                   SELECT count(*) = 2
                          AND count(*) FILTER (
                              WHERE acl.grantee = v_expected_owner
                                AND acl.grantor = v_expected_owner
                                AND acl.privilege_type = 'EXECUTE'
                                AND NOT acl.is_grantable
                          ) = 1
                          AND count(*) FILTER (
                              WHERE acl.grantee = v_service_role
                                AND acl.grantor = v_expected_owner
                                AND acl.privilege_type = 'EXECUTE'
                                AND NOT acl.is_grantable
                          ) = 1
                     FROM pg_catalog.aclexplode(procedure.proacl) AS acl
               )
          INTO v_recovery_valid
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = v_recovery_oid;
    END IF;

    IF NOT COALESCE(
        v_relation_hash =
            '072ca06532205ef065af9490c3dd3213385504eb3998e2534a939967853e4222'
        AND v_type_hash =
            'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
        AND v_table_acl_hash = CASE v_server_major
            WHEN 17 THEN
                'd588b45201221b60a38b2c4254af121ad1c3c2ce27c50d899c8d47bf8f868795'
            ELSE
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
        END
        AND v_columns_hash =
            '025892f2c4330b247df11a1eeac457ed8b60e16d27286b141a9d293a600519af'
        AND v_indexes_hash =
            '5ca695dcb9d2140ff5cb483c95a9afd93fd329e84bbf5e28bd3710b0054e87c2'
        AND v_policies_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_triggers_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_auxiliary_hash =
            '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
        AND v_dispatch_routine_count = 3
        AND v_dispatch_routines_hash =
            '11debe47e11932b2c4ec0fbe84adb5599f8a76b69122b51dae4ea7216621bbcb'
        AND (
            (
                v_constraints_hash =
                    '290ed9b9ca68d4ac8d7e36f63c877fc7a0b5e3a6edc61cf3bb9b598e0b67bdab'
                AND v_recovery_oid IS NULL
                AND v_named_routine_count = 0
            )
            OR (
                v_constraints_hash =
                    '39264dfaaa03c7483d838bd2b39dfc593c664e0e48b74912b06cb76d7fd130bd'
                AND v_recovery_oid IS NOT NULL
                AND v_named_routine_count = 1
                AND v_recovery_valid
            )
        ),
        false
    ) THEN
        RAISE EXCEPTION
            'deck_quality_trace_grace_recovery_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;
END
$migration_guard$;

ALTER TABLE public.sophia_deck_quality_shadow_runs
    DROP CONSTRAINT sophia_deck_quality_shadow_terminal_precursor_new_write,
    DROP CONSTRAINT sophia_deck_quality_shadow_terminal_trace_new_write;

-- The only exception to normal trace completeness is a failed/stale row that
-- was terminalized after its trace grace deadline. A payload hash, when one
-- exists, remains inseparable from a validated safe trace root.
ALTER TABLE public.sophia_deck_quality_shadow_runs
    ADD CONSTRAINT sophia_deck_quality_shadow_terminal_precursor_new_write CHECK (
        (pending_terminal_state IS NULL AND terminal_trace_payload_hash IS NULL)
        OR (
            pending_terminal_state IN ('failed', 'stale')
            AND state IN ('finalizing', 'failed', 'stale')
            AND last_error_code IS NOT NULL
            AND last_error_stage IS NOT NULL
            AND last_error_at IS NOT NULL
            AND (
                state = 'finalizing'
                OR (
                    pending_terminal_state = state
                    AND (
                        (
                            terminal_trace_payload_hash ~ '^[0-9a-f]{64}$'
                            AND safe_trace_root_input IS NOT NULL
                        )
                        OR (
                            finished_at IS NOT NULL
                            AND finished_at >= trace_deadline_at
                            AND finished_at = updated_at
                            AND (
                                terminal_trace_payload_hash IS NULL
                                OR safe_trace_root_input IS NOT NULL
                            )
                        )
                    )
                )
            )
        )
    ) NOT VALID,
    ADD CONSTRAINT sophia_deck_quality_shadow_terminal_trace_new_write CHECK (
        state NOT IN ('completed', 'failed', 'stale')
        OR (
            trace_ids ?& ARRAY[
                'quality_trace_id', 'quality_root_run_id', 'dispatch_run_id',
                'snapshot_run_id', 'evidence_run_id', 'blind_visual_run_id',
                'mechanical_projection_run_id', 'plan_realization_run_id',
                'adjudicate_run_id', 'shadow_persist_run_id'
            ]
            AND trace_ids ->> 'quality_trace_id' =
                trace_ids ->> 'quality_root_run_id'
            AND safe_trace_root_input IS NOT NULL
        )
        OR (
            state IN ('failed', 'stale')
            AND pending_terminal_state = state
            AND finished_at IS NOT NULL
            AND finished_at >= trace_deadline_at
            AND finished_at = updated_at
            AND (
                terminal_trace_payload_hash IS NULL
                OR safe_trace_root_input IS NOT NULL
            )
        )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.sophia_recover_expired_deck_quality_shadow_runs(
    p_limit INTEGER DEFAULT 100
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $recovery$
DECLARE
    v_now TIMESTAMPTZ := statement_timestamp();
    v_recovered INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'deck_quality_trace_grace_recovery_limit_invalid'
            USING ERRCODE = '22023';
    END IF;

    WITH eligible AS (
        SELECT run.quality_run_id,
               run.pending_terminal_state IS NULL AS prepared_success
          FROM public.sophia_deck_quality_shadow_runs AS run
         WHERE run.state = 'finalizing'
           AND run.trace_deadline_at <= v_now
           AND (
               run.lease_expires_at IS NULL
               OR run.lease_expires_at <= v_now
           )
           AND (
               run.pending_terminal_state IN ('failed', 'stale')
               OR (
                   run.pending_terminal_state IS NULL
                   AND run.stage = 'adjudicated'
                   AND run.stage_rank = 60
                   AND run.decision_result IS NOT NULL
                   AND run.stage_artifact_hashes ? 'decision'
                   AND run.stage_artifact_hashes ? 'safe_metrics'
                   AND run.stage_artifact_hashes ? 'run'
               )
           )
         ORDER BY run.trace_deadline_at,
                  run.requested_at,
                  run.quality_run_id
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
    ), recovered AS (
        UPDATE public.sophia_deck_quality_shadow_runs AS run
           SET state = COALESCE(run.pending_terminal_state, 'failed'),
               pending_terminal_state = COALESCE(
                   run.pending_terminal_state, 'failed'
               ),
               error_count = run.error_count + CASE
                   WHEN eligible.prepared_success THEN 1
                   ELSE 0
               END,
               last_error_code = CASE
                   WHEN eligible.prepared_success
                       THEN 'quality_persistence_error'
                   ELSE run.last_error_code
               END,
               last_error_stage = CASE
                   WHEN eligible.prepared_success
                       THEN 'trace_deadline'
                   ELSE run.last_error_stage
               END,
               last_error_at = CASE
                   WHEN eligible.prepared_success THEN v_now
                   ELSE run.last_error_at
               END,
               next_attempt_at = LEAST(
                   run.next_attempt_at, run.run_deadline_at
               ),
               lease_owner = NULL,
               lease_expires_at = NULL,
               claim_token = NULL,
               claim_hash = NULL,
               finished_at = v_now,
               updated_at = v_now
          FROM eligible
         WHERE run.quality_run_id = eligible.quality_run_id
         RETURNING run.quality_run_id
    )
    SELECT count(*)::INTEGER
      INTO v_recovered
      FROM recovered;

    RETURN v_recovered;
END;
$recovery$;

ALTER FUNCTION public.sophia_recover_expired_deck_quality_shadow_runs(INTEGER)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sophia_recover_expired_deck_quality_shadow_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_recover_expired_deck_quality_shadow_runs(INTEGER)
    TO service_role;

-- Refuse commit unless the two intended constraints and the one RPC are the
-- exact target surface, including owner, SECURITY DEFINER, search_path, source,
-- and ACL.
DO $migration_postflight$
DECLARE
    v_table_oid OID :=
        'public.sophia_deck_quality_shadow_runs'::REGCLASS;
    v_expected_owner OID := pg_catalog.to_regrole('postgres');
    v_service_role OID := pg_catalog.to_regrole('service_role');
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
    v_dispatch_routine_count BIGINT;
    v_dispatch_routines_hash TEXT;
    v_recovery_oid OID := pg_catalog.to_regprocedure(
        'public.sophia_recover_expired_deck_quality_shadow_runs(integer)'
    );
    v_named_routine_count BIGINT;
    v_recovery_valid BOOLEAN := false;
BEGIN
    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                           pg_catalog.obj_description(
                               relation.oid, 'pg_class'
                           )
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_relation_hash
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = relation.relowner
      LEFT JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = relation.relam
      LEFT JOIN pg_catalog.pg_tablespace AS tablespace
        ON tablespace.oid = relation.reltablespace
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_type_hash
      FROM pg_catalog.pg_type AS type
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = type.typowner
     WHERE type.oid = (
         SELECT relation.reltype
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = v_table_oid
     );

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_catalog.pg_get_userbyid(
                                            acl.grantee
                                        )
                                   END,
                                   pg_catalog.pg_get_userbyid(acl.grantor),
                                   acl.privilege_type,
                                   acl.is_grantable
                               )
                               ORDER BY
                                   CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                                        ELSE pg_catalog.pg_get_userbyid(
                                            acl.grantee
                                        )
                                   END,
                                   pg_catalog.pg_get_userbyid(acl.grantor),
                                   acl.privilege_type,
                                   acl.is_grantable
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_table_acl_hash
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) AS acl
     WHERE relation.oid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   attribute.attnum,
                                   attribute.attname,
                                   pg_catalog.format_type(
                                       attribute.atttypid,
                                       attribute.atttypmod
                                   ),
                                   attribute.attnotnull,
                                   attribute.atthasdef,
                                   pg_catalog.pg_get_expr(
                                       default_value.adbin,
                                       default_value.adrelid,
                                       false
                                   ),
                                   CASE WHEN attribute.attcollation = 0
                                        THEN '-'
                                        ELSE collation_namespace.nspname
                                             || '.'
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
                           ),
                           '[]'::JSONB
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
     WHERE attribute.attrelid = v_table_oid
       AND attribute.attnum > 0;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
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
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_constraints_hash
      FROM pg_catalog.pg_constraint AS constraint_definition
     WHERE constraint_definition.conrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
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
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
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

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   policy.polname,
                                   policy.polcmd::INTEGER,
                                   policy.polpermissive,
                                   ARRAY(
                                       SELECT CASE WHEN role_oid = 0
                                                   THEN 'PUBLIC'
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
                                       policy.polwithcheck,
                                       policy.polrelid,
                                       false
                                   )
                               ) ORDER BY policy.polname
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_policies_hash
      FROM pg_catalog.pg_policy AS policy
     WHERE policy.polrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   trigger.tgname,
                                   trigger.tgfoid::REGPROCEDURE::TEXT,
                                   trigger.tgtype,
                                   trigger.tgenabled::INTEGER,
                                   trigger.tgisinternal,
                                   CASE WHEN trigger.tgconstraint = 0
                                        THEN NULL
                                        ELSE constraint_definition.conname
                                   END,
                                   CASE WHEN trigger.tgconstrrelid = 0
                                        THEN NULL
                                        ELSE trigger.tgconstrrelid
                                             ::REGCLASS::TEXT
                                   END,
                                   trigger.tgdeferrable,
                                   trigger.tginitdeferred,
                                   trigger.tgnargs,
                                   pg_catalog.encode(trigger.tgargs, 'hex'),
                                   trigger.tgoldtable,
                                   trigger.tgnewtable,
                                   pg_catalog.pg_get_triggerdef(
                                       trigger.oid, false
                                   )
                               ) ORDER BY trigger.tgname
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_triggers_hash
      FROM pg_catalog.pg_trigger AS trigger
      LEFT JOIN pg_catalog.pg_constraint AS constraint_definition
        ON constraint_definition.oid = trigger.tgconstraint
     WHERE trigger.tgrelid = v_table_oid;

    SELECT pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
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
                                WHERE rule.ev_class = v_table_oid
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
                                   ON publication.oid =
                                      publication_relation.prpubid
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
                                WHERE description.classoid =
                                      'pg_class'::REGCLASS
                                  AND description.objoid = v_table_oid
                                  AND description.objsubid > 0
                           ), '[]'::JSONB)
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_auxiliary_hash;

    WITH routines AS (
        SELECT procedure.*,
               owner_role.rolname AS owner_name,
               language.lanname AS language_name
          FROM pg_catalog.pg_proc AS procedure
          JOIN pg_catalog.pg_roles AS owner_role
            ON owner_role.oid = procedure.proowner
          JOIN pg_catalog.pg_language AS language
            ON language.oid = procedure.prolang
         WHERE procedure.pronamespace = 'public'::REGNAMESPACE
           AND procedure.proname = ANY (ARRAY[
               'sophia_begin_deck_quality_shadow_dispatch',
               'sophia_resolve_deck_quality_shadow_dispatch',
               'sophia_list_unresolved_deck_quality_shadow_dispatches'
           ]::TEXT[])
    ), canonical AS (
        SELECT procedure.proname,
               pg_catalog.pg_get_function_identity_arguments(
                   procedure.oid
               ) AS identity_arguments,
               pg_catalog.jsonb_build_array(
                   procedure.proname,
                   pg_catalog.pg_get_function_identity_arguments(
                       procedure.oid
                   ),
                   pg_catalog.pg_get_function_arguments(procedure.oid),
                   pg_catalog.pg_get_function_result(procedure.oid),
                   procedure.owner_name,
                   procedure.language_name,
                   procedure.prokind::INTEGER,
                   procedure.provolatile::INTEGER,
                   procedure.proisstrict,
                   procedure.prosecdef,
                   procedure.proleakproof,
                   procedure.proparallel::INTEGER,
                   procedure.proretset,
                   pg_catalog.format_type(procedure.prorettype, NULL),
                   procedure.pronargs,
                   procedure.pronargdefaults,
                   pg_catalog.pg_get_expr(
                       procedure.proargdefaults, 0, false
                   ),
                   CASE WHEN procedure.provariadic = 0 THEN NULL
                        ELSE pg_catalog.format_type(
                            procedure.provariadic, NULL
                        )
                   END,
                   ARRAY(
                       SELECT pg_catalog.format_type(argument_type, NULL)
                         FROM pg_catalog.unnest(
                             procedure.proargtypes::OID[]
                         ) WITH ORDINALITY
                              AS input_type(argument_type, ordinal)
                        ORDER BY ordinal
                   ),
                   CASE WHEN procedure.proallargtypes IS NULL THEN NULL
                        ELSE ARRAY(
                            SELECT pg_catalog.format_type(
                                       argument_type, NULL
                                   )
                              FROM pg_catalog.unnest(
                                  procedure.proallargtypes
                              ) WITH ORDINALITY
                                   AS all_type(argument_type, ordinal)
                             ORDER BY ordinal
                        )
                   END,
                   procedure.proargmodes::TEXT[],
                   procedure.proargnames,
                   procedure.proconfig,
                   procedure.procost,
                   procedure.prorows,
                   CASE WHEN procedure.prosupport = 0 THEN NULL
                        ELSE procedure.prosupport::REGPROC::TEXT
                   END,
                   CASE WHEN procedure.protrftypes IS NULL THEN NULL
                        ELSE ARRAY(
                            SELECT pg_catalog.format_type(
                                       transform_type, NULL
                                   )
                              FROM pg_catalog.unnest(
                                  procedure.protrftypes
                              ) WITH ORDINALITY
                                   AS transform(transform_type, ordinal)
                             ORDER BY ordinal
                        )
                   END,
                   procedure.probin,
                   procedure.prosqlbody::TEXT,
                   procedure.proacl IS NULL,
                   COALESCE((
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
                                  )
                                  ORDER BY
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
                   pg_catalog.obj_description(
                       procedure.oid, 'pg_proc'
                   ),
                   pg_catalog.encode(
                       pg_catalog.sha256(
                           pg_catalog.convert_to(procedure.prosrc, 'UTF8')
                       ),
                       'hex'
                   ),
                   pg_catalog.encode(
                       pg_catalog.sha256(
                           pg_catalog.convert_to(
                               pg_catalog.pg_get_functiondef(procedure.oid),
                               'UTF8'
                           )
                       ),
                       'hex'
                   )
               ) AS definition
          FROM routines AS procedure
    )
    SELECT count(*),
           pg_catalog.encode(
               pg_catalog.sha256(
                   pg_catalog.convert_to(
                       COALESCE(
                           pg_catalog.jsonb_agg(
                               definition
                               ORDER BY proname, identity_arguments
                           ),
                           '[]'::JSONB
                       )::TEXT,
                       'UTF8'
                   )
               ),
               'hex'
           )
      INTO v_dispatch_routine_count, v_dispatch_routines_hash
      FROM canonical;

    SELECT count(*)
      INTO v_named_routine_count
      FROM pg_catalog.pg_proc AS procedure
     WHERE procedure.pronamespace = 'public'::REGNAMESPACE
       AND procedure.proname =
           'sophia_recover_expired_deck_quality_shadow_runs';

    IF v_recovery_oid IS NOT NULL THEN
        SELECT procedure.prokind = 'f'
               AND procedure.proowner = v_expected_owner
               AND procedure.prolang = (
                   SELECT language.oid
                     FROM pg_catalog.pg_language AS language
                    WHERE language.lanname = 'plpgsql'
               )
               AND procedure.procost = 100
               AND procedure.prorows = 0
               AND procedure.provariadic = 0
               AND procedure.prosupport = 0
               AND procedure.prorettype = 'integer'::REGTYPE
               AND NOT procedure.proretset
               AND procedure.provolatile = 'v'
               AND procedure.proparallel = 'u'
               AND procedure.prosecdef
               AND NOT procedure.proleakproof
               AND NOT procedure.proisstrict
               AND procedure.pronargs = 1
               AND procedure.pronargdefaults = 1
               AND procedure.proconfig = ARRAY['search_path=public']::TEXT[]
               AND procedure.probin IS NULL
               AND procedure.prosqlbody IS NULL
               AND pg_catalog.obj_description(
                   procedure.oid, 'pg_proc'
               ) IS NULL
               AND pg_catalog.encode(pg_catalog.sha256(
                   pg_catalog.convert_to(procedure.prosrc, 'UTF8')
               ), 'hex') = 'fb1082d007d69721898aa5908c54cbbde5cf498ee965b7a111353c389928c711'
               AND (
                   SELECT count(*) = 2
                          AND count(*) FILTER (
                              WHERE acl.grantee = v_expected_owner
                                AND acl.grantor = v_expected_owner
                                AND acl.privilege_type = 'EXECUTE'
                                AND NOT acl.is_grantable
                          ) = 1
                          AND count(*) FILTER (
                              WHERE acl.grantee = v_service_role
                                AND acl.grantor = v_expected_owner
                                AND acl.privilege_type = 'EXECUTE'
                                AND NOT acl.is_grantable
                          ) = 1
                     FROM pg_catalog.aclexplode(procedure.proacl) AS acl
               )
          INTO v_recovery_valid
          FROM pg_catalog.pg_proc AS procedure
         WHERE procedure.oid = v_recovery_oid;
    END IF;

    IF NOT COALESCE(
        v_relation_hash =
            '072ca06532205ef065af9490c3dd3213385504eb3998e2534a939967853e4222'
        AND v_type_hash =
            'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
        AND v_table_acl_hash = CASE v_server_major
            WHEN 17 THEN
                'd588b45201221b60a38b2c4254af121ad1c3c2ce27c50d899c8d47bf8f868795'
            ELSE
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
        END
        AND v_columns_hash =
            '025892f2c4330b247df11a1eeac457ed8b60e16d27286b141a9d293a600519af'
        AND v_constraints_hash =
            '39264dfaaa03c7483d838bd2b39dfc593c664e0e48b74912b06cb76d7fd130bd'
        AND v_indexes_hash =
            '5ca695dcb9d2140ff5cb483c95a9afd93fd329e84bbf5e28bd3710b0054e87c2'
        AND v_policies_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_triggers_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_auxiliary_hash =
            '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
        AND v_dispatch_routine_count = 3
        AND v_dispatch_routines_hash =
            '11debe47e11932b2c4ec0fbe84adb5599f8a76b69122b51dae4ea7216621bbcb'
        AND v_named_routine_count = 1
        AND v_recovery_valid,
        false
    ) THEN
        RAISE EXCEPTION 'deck_quality_trace_grace_recovery_postflight_failed'
            USING ERRCODE = '55000';
    END IF;
END
$migration_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
