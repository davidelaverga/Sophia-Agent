-- DQ-1 durable launch-intent fence.
--
-- LangGraph does not accept a caller-supplied run ID or idempotency key for
-- stateful run creation.  The gateway therefore records a content-free intent
-- before the physical create.  An unresolved intent is never overwritten by a
-- later lease unless durable graph progress proves that the prior execution
-- advanced to an actionable retry/finalization state.

BEGIN;

-- Accept only the exact 07/18 predecessor or an exact replay of the 07/19
-- surface below.  The ACCESS EXCLUSIVE lock prevents a catalog fingerprint
-- from becoming stale before the idempotent DDL and postflight complete.
DO $migration_guard$
DECLARE
    v_table_oid OID;
    v_expected_owner OID := pg_catalog.to_regrole('postgres');
    v_executor_owner OID := pg_catalog.to_regrole(current_user);
    v_anon OID := pg_catalog.to_regrole('anon');
    v_authenticated OID := pg_catalog.to_regrole('authenticated');
    v_service_role OID := pg_catalog.to_regrole('service_role');
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
    IF v_expected_owner IS NULL
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
        RAISE EXCEPTION 'deck_quality_dispatch_intent_environment_invalid'
            USING ERRCODE = '55000';
    END IF;

    LOCK TABLE public.sophia_deck_quality_shadow_runs
        IN ACCESS EXCLUSIVE MODE;
    v_table_oid := 'public.sophia_deck_quality_shadow_runs'::REGCLASS;

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
                                   attribute.attstattarget,
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
      INTO v_named_routine_count, v_routines_hash
      FROM canonical;

    IF NOT COALESCE(
        (
            v_relation_hash =
                'b94d81cab3cd8c3b5d52688d25d13140db436c5e84919bb42837efc7d4b7c7af'
            AND v_type_hash =
                'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
            AND v_table_acl_hash =
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
            AND v_columns_hash =
                '5e1910787719dab7c6990a09561f777697ddd29e30f71a344bbeead60a4eb7b4'
            AND v_constraints_hash =
                'a42f81cd3a9d32172fd1d24325bab0ddcfd243302af9270b397e3137552a0958'
            AND v_indexes_hash =
                '5ca695dcb9d2140ff5cb483c95a9afd93fd329e84bbf5e28bd3710b0054e87c2'
            AND v_policies_hash =
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
            AND v_triggers_hash =
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
            AND v_auxiliary_hash =
                '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
            AND v_named_routine_count = 0
            AND v_routines_hash =
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        )
        OR (
            v_relation_hash =
                '072ca06532205ef065af9490c3dd3213385504eb3998e2534a939967853e4222'
            AND v_type_hash =
                'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
            AND v_table_acl_hash =
                'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
            AND v_columns_hash =
                '025892f2c4330b247df11a1eeac457ed8b60e16d27286b141a9d293a600519af'
            AND v_constraints_hash =
                '290ed9b9ca68d4ac8d7e36f63c877fc7a0b5e3a6edc61cf3bb9b598e0b67bdab'
            AND v_indexes_hash =
                '5ca695dcb9d2140ff5cb483c95a9afd93fd329e84bbf5e28bd3710b0054e87c2'
            AND v_policies_hash =
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
            AND v_triggers_hash =
                '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
            AND v_auxiliary_hash =
                '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
            AND v_named_routine_count = 3
            AND v_routines_hash =
                '11debe47e11932b2c4ec0fbe84adb5599f8a76b69122b51dae4ea7216621bbcb'
        ),
        false
    ) THEN
        RAISE EXCEPTION 'deck_quality_dispatch_intent_unknown_fingerprint'
            USING ERRCODE = '55000';
    END IF;
END
$migration_guard$;

ALTER TABLE public.sophia_deck_quality_shadow_runs
    ADD COLUMN IF NOT EXISTS dispatch_intent_epoch BIGINT,
    ADD COLUMN IF NOT EXISTS dispatch_intent_attempt_count INTEGER,
    ADD COLUMN IF NOT EXISTS dispatch_intent_token TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_intent_status TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_recovery_proof_hash TEXT,
    ADD COLUMN IF NOT EXISTS dispatch_intent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dispatch_resolved_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'public.sophia_deck_quality_shadow_runs'::regclass
           AND conname = 'sophia_deck_quality_dispatch_intent_shape'
    ) THEN
        ALTER TABLE public.sophia_deck_quality_shadow_runs
            ADD CONSTRAINT sophia_deck_quality_dispatch_intent_shape CHECK (
                (
                    dispatch_intent_status IS NULL
                    AND dispatch_intent_epoch IS NULL
                    AND dispatch_intent_attempt_count IS NULL
                    AND dispatch_intent_token IS NULL
                    AND dispatch_recovery_proof_hash IS NULL
                    AND dispatch_intent_at IS NULL
                    AND dispatch_resolved_at IS NULL
                )
                OR (
                    dispatch_intent_status IN ('prepared', 'unresolved', 'confirmed', 'reconciled')
                    AND dispatch_intent_epoch >= 1
                    AND dispatch_intent_epoch <= lease_epoch
                    AND dispatch_intent_attempt_count >= 0
                    AND dispatch_intent_attempt_count <= max_attempts
                    AND dispatch_intent_token ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
                    AND (
                        dispatch_recovery_proof_hash IS NULL
                        OR dispatch_recovery_proof_hash ~ '^[0-9a-f]{64}$'
                    )
                    AND dispatch_intent_at IS NOT NULL
                    AND isfinite(dispatch_intent_at)
                    AND (
                        (
                            dispatch_intent_status IN ('confirmed', 'reconciled')
                            AND dispatch_resolved_at IS NOT NULL
                            AND isfinite(dispatch_resolved_at)
                            AND dispatch_resolved_at >= dispatch_intent_at
                        )
                        OR (
                            dispatch_intent_status IN ('prepared', 'unresolved')
                            AND dispatch_resolved_at IS NULL
                        )
                    )
                )
            );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_begin_deck_quality_shadow_dispatch(
    p_quality_run_id TEXT,
    p_lease_owner TEXT,
    p_lease_epoch BIGINT,
    p_dispatch_intent_token TEXT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
    v_recovery_proof_hash TEXT;
    v_recovery_proven BOOLEAN;
    v_stage_artifact_key TEXT;
    v_resumable_error BOOLEAN;
    v_safe_prelaunch_replay BOOLEAN;
BEGIN
    IF p_quality_run_id IS NULL OR p_quality_run_id !~ '^quality_[0-9a-f]{64}$'
       OR p_lease_owner IS NULL OR p_lease_owner !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       OR p_lease_epoch IS NULL OR p_lease_epoch < 1
       OR p_dispatch_intent_token IS NULL
       OR p_dispatch_intent_token !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' THEN
        RAISE EXCEPTION 'deck_quality_dispatch_intent_invalid' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_run
      FROM public.sophia_deck_quality_shadow_runs
     WHERE quality_run_id = p_quality_run_id
     FOR UPDATE;
    IF NOT FOUND
       OR v_run.state NOT IN ('running', 'finalizing')
       OR v_run.lease_owner IS DISTINCT FROM p_lease_owner
       OR v_run.lease_epoch IS DISTINCT FROM p_lease_epoch
       OR v_run.lease_expires_at IS NULL
       OR v_run.lease_expires_at <= statement_timestamp() THEN
        RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
    END IF;

    v_stage_artifact_key := CASE v_run.stage
        WHEN 'snapshot_loaded' THEN 'source_snapshot'
        WHEN 'evidence_prepared' THEN 'evidence_manifest'
        WHEN 'blind_assessed' THEN 'assessment_a_visual'
        WHEN 'mechanical_projected' THEN 'assessment_b_mechanical'
        WHEN 'plan_realization_assessed'
            THEN 'assessment_c_plan_realization'
        WHEN 'adjudicated' THEN 'decision'
        ELSE NULL
    END;
    v_resumable_error := (
        v_run.last_error_code IS NOT NULL
        AND v_run.last_error_code <> 'shadow_dispatch_unavailable'
        AND v_run.last_error_stage IS NOT NULL
        AND v_run.last_error_at IS NOT NULL
    );
    -- This exact dispatcher-authored error pair is durable proof that the
    -- prior invocation stopped before runs.create.  It therefore authorizes
    -- one later intent; shadow_dispatch_launch remains ambiguous and fenced.
    v_safe_prelaunch_replay := (
        v_run.last_error_code = 'shadow_dispatch_unavailable'
        AND v_run.last_error_stage = 'shadow_dispatch_prelaunch'
        AND v_run.last_error_at IS NOT NULL
    );
    IF v_run.stage_rank > 0
       AND (
           v_stage_artifact_key IS NULL
           OR NOT (v_run.stage_artifact_hashes ? v_stage_artifact_key)
       ) THEN
        RAISE EXCEPTION 'deck_quality_dispatch_checkpoint_invalid'
            USING ERRCODE = '55000';
    END IF;

    -- The proof is deliberately derived only from graph-authored durable
    -- recovery state. Claim, lease, attempt, retry scheduling, updated_at, and
    -- dispatcher-authored shadow_dispatch_unavailable fields are excluded.
    -- Every monotonic graph checkpoint is observable recovery progress, while
    -- an unchanged checkpoint remains consumed across later lease reclaims.
    -- A pending failure precursor takes precedence so adding its immutable
    -- terminal trace hash permits exactly one further replay.
    v_recovery_proof_hash := CASE
        WHEN v_run.state = 'finalizing'
             AND v_run.pending_terminal_state IS NOT NULL
             AND v_run.last_error_code IS NOT NULL
             AND v_run.last_error_code <> 'shadow_dispatch_unavailable'
             AND v_run.last_error_stage IS NOT NULL
             AND v_run.last_error_at IS NOT NULL THEN
            encode(sha256(convert_to(jsonb_build_object(
                'proof_kind', 'pending_terminal',
                'pending_terminal_state', v_run.pending_terminal_state,
                'terminal_trace_payload_hash', v_run.terminal_trace_payload_hash,
                'last_error_code', v_run.last_error_code,
                'last_error_stage', v_run.last_error_stage,
                'last_error_at', extract(epoch FROM v_run.last_error_at),
                'safe_trace_root_input_hash', v_run.safe_trace_root_input_hash
            )::TEXT, 'UTF8')), 'hex')
        WHEN v_run.state = 'finalizing'
             AND v_run.pending_terminal_state IS NULL
             AND v_run.decision_result IS NOT NULL
             AND v_run.stage_artifact_hashes ? 'decision'
             AND v_run.safe_trace_root_input_hash IS NOT NULL THEN
            encode(sha256(convert_to(jsonb_build_object(
                'proof_kind', 'prepared_success',
                'decision_result', v_run.decision_result,
                'decision_stage_hash', v_run.stage_artifact_hashes ->> 'decision',
                'safe_trace_root_input_hash', v_run.safe_trace_root_input_hash
            )::TEXT, 'UTF8')), 'hex')
        WHEN v_safe_prelaunch_replay THEN
            encode(sha256(convert_to(jsonb_build_object(
                'proof_kind', 'dispatch_prelaunch',
                'last_error_code', v_run.last_error_code,
                'last_error_stage', v_run.last_error_stage,
                'last_error_at', extract(epoch FROM v_run.last_error_at)
            )::TEXT, 'UTF8')), 'hex')
        WHEN v_run.stage_rank > 0 OR v_resumable_error THEN
            encode(sha256(convert_to(jsonb_build_object(
                'proof_kind', 'resumable_progress',
                'stage', v_run.stage,
                'stage_rank', v_run.stage_rank,
                'stage_artifact_key', CASE
                    WHEN v_run.stage_rank > 0
                    THEN v_stage_artifact_key
                    ELSE NULL
                END,
                'stage_artifact_hash', CASE
                    WHEN v_run.stage_rank > 0
                    THEN v_run.stage_artifact_hashes ->>
                        v_stage_artifact_key
                    ELSE NULL
                END,
                'last_error_code', CASE
                    WHEN v_resumable_error
                    THEN v_run.last_error_code
                    ELSE NULL
                END,
                'last_error_stage', CASE
                    WHEN v_resumable_error
                    THEN v_run.last_error_stage
                    ELSE NULL
                END,
                'last_error_at', CASE
                    WHEN v_resumable_error
                    THEN extract(epoch FROM v_run.last_error_at)
                    ELSE NULL
                END
            )::TEXT, 'UTF8')), 'hex')
        ELSE NULL
    END;
    v_recovery_proven := (
        v_recovery_proof_hash IS NOT NULL
        AND v_run.dispatch_recovery_proof_hash IS DISTINCT FROM
            v_recovery_proof_hash
    );

    IF (
        v_run.dispatch_intent_status IS NULL
        AND (v_run.attempt_count = 1 OR v_recovery_proven)
    ) OR (
        v_run.dispatch_intent_status IS NOT NULL
        AND v_recovery_proven
    ) THEN
        UPDATE public.sophia_deck_quality_shadow_runs
           SET dispatch_intent_epoch = p_lease_epoch,
               dispatch_intent_attempt_count = attempt_count,
               dispatch_intent_token = p_dispatch_intent_token,
               dispatch_intent_status = 'prepared',
               dispatch_recovery_proof_hash = v_recovery_proof_hash,
               dispatch_intent_at = statement_timestamp(),
               dispatch_resolved_at = NULL
         WHERE quality_run_id = p_quality_run_id
           AND state IN ('running', 'finalizing')
           AND lease_owner = p_lease_owner
           AND lease_epoch = p_lease_epoch
           AND lease_expires_at > statement_timestamp()
         RETURNING * INTO v_run;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
        END IF;
    ELSIF v_run.dispatch_intent_status IS NULL THEN
        -- Forward-migration cutover: a later attempt with no durable prior
        -- launch marker and no graph-originated recovery proof is ambiguous.
        -- Persist a synthetic unresolved fence and never guess by relaunching.
        UPDATE public.sophia_deck_quality_shadow_runs
           SET dispatch_intent_epoch = p_lease_epoch,
               dispatch_intent_attempt_count = attempt_count,
               dispatch_intent_token = p_dispatch_intent_token,
               dispatch_intent_status = 'unresolved',
               dispatch_recovery_proof_hash = v_recovery_proof_hash,
               dispatch_intent_at = statement_timestamp(),
               dispatch_resolved_at = NULL
         WHERE quality_run_id = p_quality_run_id
           AND state IN ('running', 'finalizing')
           AND lease_owner = p_lease_owner
           AND lease_epoch = p_lease_epoch
           AND lease_expires_at > statement_timestamp()
         RETURNING * INTO v_run;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'deck_quality_lease_stale' USING ERRCODE = '40001';
        END IF;
    END IF;

    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_resolve_deck_quality_shadow_dispatch(
    p_quality_run_id TEXT,
    p_dispatch_intent_token TEXT,
    p_dispatch_intent_status TEXT
) RETURNS SETOF public.sophia_deck_quality_shadow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_run public.sophia_deck_quality_shadow_runs%ROWTYPE;
BEGIN
    IF p_quality_run_id IS NULL OR p_quality_run_id !~ '^quality_[0-9a-f]{64}$'
       OR p_dispatch_intent_token IS NULL
       OR p_dispatch_intent_token !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'
       OR p_dispatch_intent_status IS NULL
       OR p_dispatch_intent_status NOT IN ('unresolved', 'confirmed', 'reconciled') THEN
        RAISE EXCEPTION 'deck_quality_dispatch_resolution_invalid' USING ERRCODE = '22023';
    END IF;

    UPDATE public.sophia_deck_quality_shadow_runs
       SET dispatch_intent_status = CASE
               WHEN dispatch_intent_status = 'reconciled'
                    OR p_dispatch_intent_status = 'reconciled' THEN 'reconciled'
               ELSE p_dispatch_intent_status
           END,
           dispatch_resolved_at = CASE
               WHEN dispatch_intent_status = 'reconciled'
                    OR p_dispatch_intent_status IN ('confirmed', 'reconciled')
                   THEN COALESCE(dispatch_resolved_at, statement_timestamp())
               ELSE NULL
           END
     WHERE quality_run_id = p_quality_run_id
       AND dispatch_intent_token = p_dispatch_intent_token
       AND dispatch_intent_status IN (
           'prepared', 'unresolved', 'confirmed', 'reconciled'
       )
     RETURNING * INTO v_run;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'deck_quality_dispatch_resolution_conflict' USING ERRCODE = '40001';
    END IF;

    RETURN NEXT v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.sophia_list_unresolved_deck_quality_shadow_dispatches(
    p_limit INTEGER DEFAULT 100
) RETURNS TABLE(quality_run_id TEXT, dispatch_intent_status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'deck_quality_dispatch_list_invalid' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT run.quality_run_id, run.dispatch_intent_status
      FROM public.sophia_deck_quality_shadow_runs AS run
     WHERE run.state NOT IN ('completed', 'failed', 'stale')
       AND (
           run.dispatch_intent_status IN ('prepared', 'unresolved', 'reconciled')
           OR (
               run.dispatch_intent_status = 'confirmed'
               AND run.state IN ('running', 'finalizing')
               AND run.lease_expires_at <= statement_timestamp()
           )
       )
     ORDER BY run.dispatch_intent_at, run.quality_run_id
     LIMIT p_limit;
END;
$$;

ALTER FUNCTION public.sophia_begin_deck_quality_shadow_dispatch(TEXT, TEXT, BIGINT, TEXT)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_resolve_deck_quality_shadow_dispatch(TEXT, TEXT, TEXT)
    OWNER TO postgres;
ALTER FUNCTION public.sophia_list_unresolved_deck_quality_shadow_dispatches(INTEGER)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.sophia_begin_deck_quality_shadow_dispatch(TEXT, TEXT, BIGINT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_begin_deck_quality_shadow_dispatch(TEXT, TEXT, BIGINT, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.sophia_resolve_deck_quality_shadow_dispatch(TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_resolve_deck_quality_shadow_dispatch(TEXT, TEXT, TEXT)
    TO service_role;

REVOKE ALL ON FUNCTION public.sophia_list_unresolved_deck_quality_shadow_dispatches(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sophia_list_unresolved_deck_quality_shadow_dispatches(INTEGER)
    TO service_role;

-- Recompute the complete target fingerprint after every statement.  This is
-- deliberately independent of CREATE OR REPLACE success: commit is forbidden
-- unless the installed surface is the one exact 07/19 state.
DO $migration_postflight$
DECLARE
    v_table_oid OID :=
        'public.sophia_deck_quality_shadow_runs'::REGCLASS;
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
                       attribute.attstattarget,
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
                   pg_catalog.obj_description(procedure.oid, 'pg_proc'),
                   pg_catalog.encode(pg_catalog.sha256(
                       pg_catalog.convert_to(procedure.prosrc, 'UTF8')
                   ), 'hex'),
                   pg_catalog.encode(pg_catalog.sha256(
                       pg_catalog.convert_to(
                           pg_catalog.pg_get_functiondef(procedure.oid),
                           'UTF8'
                       )
                   ), 'hex')
               ) AS definition
          FROM routines AS procedure
    )
    SELECT count(*),
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               COALESCE(pg_catalog.jsonb_agg(
                   definition ORDER BY proname, identity_arguments
               ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
      INTO v_named_routine_count, v_routines_hash
      FROM canonical;

    IF NOT COALESCE(
        v_relation_hash =
            '072ca06532205ef065af9490c3dd3213385504eb3998e2534a939967853e4222'
        AND v_type_hash =
            'ae1919ddfe81e006aaedfef1093405cd85dd52527bb68202c485ac82fef89613'
        AND v_table_acl_hash =
            'a8da39f5eed4051f8b01b095e5f335018f24f451cc941003aa5e389660e468bf'
        AND v_columns_hash =
            '025892f2c4330b247df11a1eeac457ed8b60e16d27286b141a9d293a600519af'
        AND v_constraints_hash =
            '290ed9b9ca68d4ac8d7e36f63c877fc7a0b5e3a6edc61cf3bb9b598e0b67bdab'
        AND v_indexes_hash =
            '5ca695dcb9d2140ff5cb483c95a9afd93fd329e84bbf5e28bd3710b0054e87c2'
        AND v_policies_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_triggers_hash =
            '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945'
        AND v_auxiliary_hash =
            '7d5f4fc273264820b05beb25304b19cef82eabcae4e6262956fe70cea03c6eec'
        AND v_named_routine_count = 3
        AND v_routines_hash =
            '11debe47e11932b2c4ec0fbe84adb5599f8a76b69122b51dae4ea7216621bbcb',
        false
    ) THEN
        RAISE EXCEPTION 'deck_quality_dispatch_intent_postflight_failed'
            USING ERRCODE = '55000';
    END IF;
END
$migration_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
