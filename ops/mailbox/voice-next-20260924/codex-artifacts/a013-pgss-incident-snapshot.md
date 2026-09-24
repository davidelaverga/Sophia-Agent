# A-013 pg_stat_statements incident snapshot

Captured 2026-09-24 23:01–23:03 UTC before reset; current database `postgres` (dbid 5). Pre-reset `stats_reset=2026-04-23T22:16:07Z`, `dealloc=0`.

Union of top 20 by cumulative execution time and top 20 by calls. Ranks T/C reconstruct both lists. Whitespace is folded; quoted literals are redacted; query text is at most 220 characters.

| T | C | userid:queryid | calls | total_exec_ms | normalized query |
| ---: | ---: | --- | ---: | ---: | --- |
| 1 | 1 | 16482:-7821780334453251234 | 424502415 | 12339128.210 | select set_config(?, $1, true), set_config(?, $2, true), set_config(?, $3, true), set_config(?, $4, true), set_config(?, $5, true), set_config(? |
| 2 | 22 | 236220:7355157213294712995 | 632289 | 2686649.280 | SELECT procedure.proname, pg_get_function_identity_arguments(procedure.oid) FROM pg_catalog.pg_proc procedure JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace WHERE namespace.nspname = $1 |
| 9 | 2 | 236220:-3212249281209149442 | 8220008 | 502401.833 | SELECT privilege, has_table_privilege( current_user, format($3, $1::text), privilege ) FROM unnest($2::text[]) privilege ORDER BY privilege |
| 3 | 6 | 16482:-3774537435257700834 | 3264900 | 1703854.890 | select * from storage.search($1,$2,$3,$4,$5,$6,$7,$8) |
| 88 | 3 | 16596:11701968915743190 | 3706119 | 4141.243 | BEGIN |
| 4 | 29 | 236220:-5369525629997856280 | 632270 | 1422482.455 | SELECT procedure.proname, pg_get_function_identity_arguments(procedure.oid), pg_get_function_result(procedure.oid), language.lanname, procedure.provolatile, procedure.prosecdef, procedure.proisstrict, procedure.proparall |
| 90 | 4 | 16482:-2835399305386018931 | 3701362 | 4101.706 | COMMIT |
| 5 | 75 | 194805:3225967822762976635 | 29649 | 1240811.037 | SELECT pg_advisory_xact_lock(hashtextextended($1, $2)) |
| 29 | 5 | 16482:-5450541783198011430 | 3393772 | 107228.620 | SELECT set_config(?, $1, true), set_config(?, $2, true), set_config(?, $3, true), set_config(?, $4, true), set_config(?, $5, true), set_con |
| 6 | 11 | 16482:-1158805193726249566 | 1133130 | 1182051.714 | WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_lease_owner", "p_claim_token", "p_claim_hash", "p_lease_seconds", "p_limit" FROM json_to_record(pgrst_payload.js |
| 7 | 13 | 16482:2093538402402101670 | 1106049 | 1180043.929 | WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_lease_owner", "p_claim_token", "p_claim_hash", "p_lease_seconds", "p_limit" FROM json_to_record(pgrst_payload.js |
| 31 | 7 | 16482:2080157377206608477 | 2343834 | 97916.106 | WITH pgrst_source AS ( SELECT "public"."sophia_memory_contract"."contract_epoch", "public"."sophia_memory_contract"."schema_version", "public"."sophia_memory_contract"."mode", "public"."sophia_memory_contract"."updated_a |
| 8 | 19 | 236220:7160915838158416790 | 632325 | 669460.432 | WITH application_schemas AS ( SELECT namespace.oid, namespace.nspname FROM pg_catalog.pg_namespace namespace WHERE namespace.nspname <> $1 AND namespace.nspname <> $2 AND namespace.nspname <> $3 AND namespace.nspname !~ |
| 18 | 8 | 16385:1689837619145390454 | 2215943 | 261813.842 | SELECT * FROM pgbouncer.get_auth($1) |
| 16 | 9 | 16482:-8921573913340439724 | 1142971 | 294382.535 | WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_lease_owner", "p_lease_seconds" FROM json_to_record(pgrst_payload.json_data) AS _("p_lease_owner" text, "p_lease |
| 10 | 27 | 236220:4996761675413371181 | 632275 | 462402.275 | SELECT table_relation.relname, index_relation.relname, index_row.indisunique, index_row.indisvalid, index_row.indisready, index_row.indimmediate, index_row.indnkeyatts, index_relation.relpersistence, access_method.amname |
| 21 | 10 | 16482:-2154064138104864155 | 1133141 | 214928.300 | WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_limit" FROM json_to_record(pgrst_payload.json_data) AS _("p_limit" integer) LIMIT $4) pgrst_body , LATERAL "publ |
| 11 | 40 | 16482:-7113567271881309186 | 163118 | 444968.759 | select name,id,updated_at,created_at,last_accessed_at,metadata,version,archived_at,is_delete_marker,is_versioned from storage.search($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) |
| 12 | 23 | 236220:2960206392707098952 | 632282 | 417209.079 | SELECT relation.relname, pg_get_userbyid(relation.relowner), relation.relkind, relation.relpersistence, relation.relispartition, relation.relrowsecurity, relation.relforcerowsecurity, NOT EXISTS ( SELECT $1 FROM pg_catal |
| 20 | 12 | 16482:7090393625963438521 | 1114374 | 221464.492 | WITH pgrst_source AS (SELECT pgrst_call.pgrst_scalar FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_limit" FROM json_to_record(pgrst_payload.json_data) AS _("p_limit" integer) LIMIT $4) pgrst_body , LATE |
| 13 | 26 | 236220:-3871173533030311834 | 632277 | 372077.896 | SELECT relation.relname, constraint_row.conname, constraint_row.contype, constraint_row.convalidated, constraint_row.condeferrable, constraint_row.condeferred, pg_get_constraintdef(constraint_row.oid, $2) FROM pg_catalog |
| 14 | 226 | 16384:-3076875962393720596 | 433 | 371906.141 | with f as ( -- CTE with sane arg_modes, arg_names, and arg_types. -- All three are always of the same length. -- All three include all args, including OUT and TABLE args. with functions as ( select *, -- proargmodes is n |
| 26 | 14 | 16482:-1575623826798156311 | 743507 | 131586.161 | WITH pgrst_source AS (SELECT "pgrst_call".* FROM (SELECT $1 AS json_data) pgrst_payload, LATERAL (SELECT "p_lease_owner", "p_lease_seconds" FROM json_to_record(pgrst_payload.json_data) AS _("p_lease_owner" text, "p_lease |
| 15 | 20 | 236220:-6767924997303632558 | 632294 | 351351.564 | SELECT relation.relname FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace WHERE namespace.nspname = $1 AND relation.relkind IN ($2, $3, $4, $5, $6) AND ( ha |
| 166 | 15 | 236220:11701968915743190 | 649542 | 811.071 | BEGIN |
| 44 | 16 | 236220:-2073166519428774482 | 649479 | 18816.344 | DISCARD ALL |
| 17 | 39 | 194805:-7683103009224538355 | 197759 | 287450.172 | SELECT pg_advisory_xact_lock(hashtextextended($1, $2)) |
| 154 | 17 | 236220:-2835399305386018931 | 649470 | 987.282 | COMMIT |
| 22 | 18 | 236220:3651524230960108131 | 632328 | 190548.923 | SELECT session_user, current_user, role.rolcanlogin, role.rolsuper, role.rolinherit, role.rolcreaterole, role.rolcreatedb, role.rolreplication, role.rolbypassrls, has_schema_privilege(current_user, $1, $2), $3, ( SELECT |
| 19 | 24 | 236220:-139502163011913140 | 632282 | 230635.204 | SELECT relation.relname, attribute.attname, type.typname, CASE WHEN attribute.attnotnull THEN $2 ELSE $3 END, CASE WHEN type.typname IN ($4, $5) AND attribute.atttypmod >= $6 THEN attribute.atttypmod - $7 ELSE $8 END, CO |
