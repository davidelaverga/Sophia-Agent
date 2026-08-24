import type pg from "pg";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalRequestHash } from "./security.js";

export const VOICE_LAB_SCHEMA = "sophia_voice_lab";
export const VOICE_LAB_SCHEMA_VERSION = 3;
// Updated only after the migration bytes are finalized. migrate.ts verifies
// the exact bytes before it connects to Postgres, and persists this value in
// schema_metadata for both web and worker startup attestation.
export const VOICE_LAB_MIGRATION_SHA256 = "9396354e67e47fc304cd9af1ff2d782f3fc6ba9c953e37475efe4965b57873a6";
export const VOICE_LAB_SCHEMA_SEAL_PATH = path.join(tmpdir(), "sophia-voice-lab-schema-v3.attestation.json");

export const VOICE_LAB_TABLES = [
  "admission_reservations",
  "artifacts",
  "auth_audit",
  "browser_leases",
  "evidence_manifest_revisions",
  "evidence_manifests",
  "oauth_access_tokens",
  "oauth_authorization_codes",
  "oauth_authorization_requests",
  "oauth_client_assertion_jtis",
  "oauth_endpoint_admissions",
  "oauth_refresh_tokens",
  "operations",
  "principal_provisions",
  "run_events",
  "runs",
  "retention_tombstones",
  "schema_metadata",
  "suite_evidence_manifests",
  "suite_runs",
  "worker_heartbeats",
] as const;

type Queryable = pg.Pool | pg.PoolClient | pg.Client;

export interface SchemaAttestation {
  ok: boolean;
  detail: string;
  catalogSha256: string | null;
}

interface ReleaseSchemaSeal {
  schema_version: number;
  migration_sha256: string;
  catalog_sha256: string;
}

export async function readVoiceLabCatalog(database: Queryable, schemaName = VOICE_LAB_SCHEMA): Promise<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schemaName)) throw new Error("Voice Lab catalog schema name is invalid");
  // `pg.Client` supports only one active query. Keep this catalog sweep
  // sequential so the exact same attestation works with a checked-out client
  // during migration and with a Pool during runtime readiness.
  const [schema, tables, columns, constraints, indexes, functions, triggers, sequences, otherRelations, userTypes, policies, operators, collations, namespaceExtras] = [
    await database.query(
      `select n.nspname as schema_name,
              case when n.nspowner=(select oid from pg_roles where rolname=current_user)
                   then 'runtime' else 'foreign:'||n.nspowner::text end as owner,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'grantee',case when a.grantee=n.nspowner then 'owner' when a.grantee=0 then 'public'
                                        when a.grantee=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantee::text end,
                         'grantor',case when a.grantor=n.nspowner then 'owner' when a.grantor=0 then 'public'
                                        when a.grantor=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantor::text end,
                         'privilege',a.privilege_type,'grantable',a.is_grantable)
                         order by a.grantee,a.grantor,a.privilege_type,a.is_grantable)
                          from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a),'[]'::jsonb) as normalized_acl
         from pg_namespace n where n.nspname=$1`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,
              case when c.relowner=(select oid from pg_roles where rolname=current_user)
                   then 'runtime' else 'foreign:'||c.relowner::text end as owner,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'grantee',case when a.grantee=c.relowner then 'owner' when a.grantee=0 then 'public'
                                        when a.grantee=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantee::text end,
                         'grantor',case when a.grantor=c.relowner then 'owner' when a.grantor=0 then 'public'
                                        when a.grantor=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantor::text end,
                         'privilege',a.privilege_type,'grantable',a.is_grantable)
                         order by a.grantee,a.grantor,a.privilege_type,a.is_grantable)
                          from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),'[]'::jsonb) as normalized_acl
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relkind in ('r','p') order by c.relname`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as table_name,a.attnum,a.attname as column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) as data_type,
              a.attnotnull,coalesce(pg_get_expr(d.adbin,d.adrelid),'') as column_default,a.attidentity,a.attgenerated,coalesce(a.attacl::text,'') as column_acl
         from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
         left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where n.nspname=$1 and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped
        order by c.relname,a.attnum`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as table_name,con.conname,con.contype,pg_get_constraintdef(con.oid,true) as definition
         from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 order by c.relname,con.conname`,
      [schemaName],
    ),
    await database.query(
      `select tablename,indexname,indexdef from pg_indexes where schemaname=$1 order by tablename,indexname`,
      [schemaName],
    ),
    await database.query(
      `select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_function_result(p.oid) as result,
              p.provolatile,p.prosecdef,p.proleakproof,p.proparallel,pg_get_functiondef(p.oid) as definition,
              case when p.proowner=(select oid from pg_roles where rolname=current_user)
                   then 'runtime' else 'foreign:'||p.proowner::text end as owner,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'grantee',case when a.grantee=p.proowner then 'owner' when a.grantee=0 then 'public'
                                        when a.grantee=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantee::text end,
                         'grantor',case when a.grantor=p.proowner then 'owner' when a.grantor=0 then 'public'
                                        when a.grantor=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||a.grantor::text end,
                         'privilege',a.privilege_type,'grantable',a.is_grantable)
                         order by a.grantee,a.grantor,a.privilege_type,a.is_grantable)
                          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'[]'::jsonb) as normalized_acl
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1 order by p.proname,arguments`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as table_name,t.tgname,pg_get_triggerdef(t.oid,true) as definition
         from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and not t.tgisinternal order by c.relname,t.tgname`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as name,format_type(s.seqtypid,null) as data_type,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,
              case when c.relowner=(select oid from pg_roles where rolname=current_user)
                   then 'runtime' else 'foreign:'||c.relowner::text end as owner,
              coalesce((select jsonb_agg(jsonb_build_object(
                         'grantee',case when x.grantee=c.relowner then 'owner' when x.grantee=0 then 'public'
                                        when x.grantee=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||x.grantee::text end,
                         'grantor',case when x.grantor=c.relowner then 'owner' when x.grantor=0 then 'public'
                                        when x.grantor=(select oid from pg_roles where rolname=current_user) then 'runtime' else 'foreign:'||x.grantor::text end,
                         'privilege',x.privilege_type,'grantable',x.is_grantable)
                         order by x.grantee,x.grantor,x.privilege_type,x.is_grantable)
                          from aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) x),'[]'::jsonb) as normalized_acl,
              (select rc.relname||'.'||a.attname
                 from pg_depend d join pg_class rc on rc.oid=d.refobjid join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
                where d.classid='pg_class'::regclass and d.objid=c.oid and d.refclassid='pg_class'::regclass and d.deptype in ('a','i') limit 1) as owned_by
         from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_sequence s on s.seqrelid=c.oid
        where n.nspname=$1 and c.relkind='S' order by c.relname`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
         from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 and c.relkind in ('v','m','f','c') order by c.relname`,
      [schemaName],
    ),
    await database.query(
      `select t.typname,t.typtype,t.typcategory,format_type(t.typbasetype,t.typtypmod) as base_type,coalesce(c.relname,'') as associated_relation
         from pg_type t join pg_namespace n on n.oid=t.typnamespace
         left join pg_class c on c.oid=t.typrelid
        where n.nspname=$1 and t.typtype in ('c','d','e','r','m') order by t.typname`,
      [schemaName],
    ),
    await database.query(
      `select c.relname as table_name,p.polname,p.polcmd,p.polpermissive,pg_get_expr(p.polqual,p.polrelid) as using_expression,pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
         from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname=$1 order by c.relname,p.polname`,
      [schemaName],
    ),
    await database.query(
      `select o.oprname,format_type(o.oprleft,null) as left_type,format_type(o.oprright,null) as right_type,format_type(o.oprresult,null) as result_type
         from pg_operator o join pg_namespace n on n.oid=o.oprnamespace where n.nspname=$1 order by o.oprname,left_type,right_type`,
      [schemaName],
    ),
    await database.query(
      `select c.collname,c.collprovider,c.collisdeterministic,c.collencoding
         from pg_collation c join pg_namespace n on n.oid=c.collnamespace where n.nspname=$1 order by c.collname`,
      [schemaName],
    ),
    await database.query(
      `select object_class,object_name from (
         select 'conversion'::text as object_class,c.conname::text as object_name from pg_conversion c join pg_namespace n on n.oid=c.connamespace where n.nspname=$1
         union all select 'operator_class',c.opcname from pg_opclass c join pg_namespace n on n.oid=c.opcnamespace where n.nspname=$1
         union all select 'operator_family',f.opfname from pg_opfamily f join pg_namespace n on n.oid=f.opfnamespace where n.nspname=$1
         union all select 'text_search_configuration',c.cfgname from pg_ts_config c join pg_namespace n on n.oid=c.cfgnamespace where n.nspname=$1
         union all select 'text_search_dictionary',d.dictname from pg_ts_dict d join pg_namespace n on n.oid=d.dictnamespace where n.nspname=$1
         union all select 'text_search_parser',p.prsname from pg_ts_parser p join pg_namespace n on n.oid=p.prsnamespace where n.nspname=$1
         union all select 'text_search_template',t.tmplname from pg_ts_template t join pg_namespace n on n.oid=t.tmplnamespace where n.nspname=$1
         union all select 'extended_statistics',s.stxname from pg_statistic_ext s join pg_namespace n on n.oid=s.stxnamespace where n.nspname=$1
         union all select 'extension',e.extname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where n.nspname=$1
         union all select 'rewrite_rule',r.rulename from pg_rewrite r join pg_class c on c.oid=r.ev_class join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and r.rulename<>'_RETURN'
       ) objects order by object_class,object_name`,
      [schemaName],
    ),
  ];
  return canonicalizeCatalog({
    schema: schema.rows,
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    functions: functions.rows,
    triggers: triggers.rows,
    sequences: sequences.rows,
    other_relations: otherRelations.rows,
    user_types: userTypes.rows,
    policies: policies.rows,
    operators: operators.rows,
    collations: collations.rows,
    namespace_extras: namespaceExtras.rows,
  }, schemaName);
}

export function canonicalizeCatalog(catalog: Record<string, unknown>, schemaName = VOICE_LAB_SCHEMA): Record<string, unknown> {
  const escaped = schemaName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const qualified = new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`, "gi");
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, visit(child)]));
    if (typeof value === "string") return value.replace(qualified, "<voice_lab_schema>");
    return value;
  };
  return visit(catalog) as Record<string, unknown>;
}

export function voiceLabCatalogIsEmpty(catalog: Record<string, unknown>): boolean {
  return Object.entries(catalog).every(([key, value]) => key === "schema" || (Array.isArray(value) && value.length === 0));
}

export async function readReleaseSchemaSeal(sealPath = VOICE_LAB_SCHEMA_SEAL_PATH): Promise<ReleaseSchemaSeal> {
  const parsed = JSON.parse(await readFile(sealPath, "utf8")) as Record<string, unknown>;
  if (Object.keys(parsed).sort().join(",") !== "catalog_sha256,migration_sha256,schema_version"
    || parsed.schema_version !== VOICE_LAB_SCHEMA_VERSION
    || parsed.migration_sha256 !== VOICE_LAB_MIGRATION_SHA256
    || typeof parsed.catalog_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parsed.catalog_sha256)) {
    throw new Error("Voice Lab release schema seal is malformed");
  }
  return parsed as unknown as ReleaseSchemaSeal;
}

export async function writeReleaseSchemaSeal(catalogSha256: string, sealPath = VOICE_LAB_SCHEMA_SEAL_PATH): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(catalogSha256)) throw new Error("Voice Lab release catalog hash is invalid");
  const temporary = `${sealPath}.${process.pid}.${Date.now()}.tmp`;
  const seal: ReleaseSchemaSeal = { schema_version: VOICE_LAB_SCHEMA_VERSION, migration_sha256: VOICE_LAB_MIGRATION_SHA256, catalog_sha256: catalogSha256 };
  await writeFile(temporary, `${JSON.stringify(seal)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, sealPath);
}

export async function inspectMigrationPreflight(database: Queryable, expectedCatalogSha256: string): Promise<"fresh" | "rerun"> {
  if (!/^[a-f0-9]{64}$/.test(expectedCatalogSha256)) throw new Error("Voice Lab expected catalog hash is invalid");
  const state = await database.query<{ schema_exists: boolean; metadata_exists: boolean }>(
    `select exists(select 1 from pg_namespace where nspname=$1) as schema_exists,
            to_regclass(format('%I.schema_metadata',$1)) is not null as metadata_exists`,
    [VOICE_LAB_SCHEMA],
  );
  if (!state.rows[0]?.schema_exists) return "fresh";
  if (!state.rows[0].metadata_exists) {
    const existing = await readVoiceLabCatalog(database);
    if (!voiceLabCatalogIsEmpty(existing)) throw new Error("Voice Lab migration refused a partial pre-existing schema without release metadata");
    return "fresh";
  }
  // A schema produced by the immediately preceding runner build may contain
  // that build's differently-normalized catalog hash. The independently
  // derived release expectation remains authoritative during this one-way
  // metadata transition; arbitrary target hashes are never accepted.
  const attestation = await attestVoiceLabSchema(database, false, expectedCatalogSha256, true);
  if (!attestation.ok) throw new Error(`Voice Lab migration refused pre-existing schema drift: ${attestation.detail}`);
  return "rerun";
}

export async function attestVoiceLabSchema(database: Queryable, dmlPostflight = false, expectedCatalogSha256?: string, allowLegacyMetadataCatalog = false): Promise<SchemaAttestation> {
  let phase = "release-seal";
  try {
    const releaseCatalogSha256 = expectedCatalogSha256 ?? (await readReleaseSchemaSeal()).catalog_sha256;
    phase = "metadata";
    const metadata = await database.query<{ schema_version: number; migration_sha256: string | null; catalog_sha256: string | null }>(
      `select schema_version,migration_sha256,catalog_sha256 from ${VOICE_LAB_SCHEMA}.schema_metadata where singleton=true`,
    );
    const row = metadata.rows[0];
    if (!row || Number(row.schema_version) !== VOICE_LAB_SCHEMA_VERSION || row.migration_sha256 !== VOICE_LAB_MIGRATION_SHA256
      || (row.catalog_sha256 !== releaseCatalogSha256 && !(allowLegacyMetadataCatalog && /^[a-f0-9]{64}$/.test(row.catalog_sha256 ?? "")))) {
      return { ok: false, detail: "schema-metadata-mismatch", catalogSha256: null };
    }
    phase = "catalog";
    const catalog = await readVoiceLabCatalog(database);
    const names = (catalog.tables as Array<{ name: string }>).map((table) => table.name).sort();
    if (JSON.stringify(names) !== JSON.stringify([...VOICE_LAB_TABLES].sort())) return { ok: false, detail: "schema-table-set-mismatch", catalogSha256: null };
    const catalogSha256 = canonicalRequestHash(catalog);
    if (catalogSha256 !== releaseCatalogSha256) return { ok: false, detail: "schema-catalog-drift", catalogSha256 };
    phase = "privileges";
    const privileges = await database.query<{ schema_usage: boolean; tables_ready: boolean; columns_ready: boolean; sequences_ready: boolean; functions_ready: boolean; public_schema: boolean; public_tables: boolean; public_columns: boolean; public_sequences: boolean; public_functions: boolean; foreign_acl: boolean }>(
      `select
         has_schema_privilege(current_user,$1,'USAGE') as schema_usage,
         coalesce((select bool_and(has_table_privilege(current_user,format('%I.%I',$1,c.relname),'SELECT')
                                  and has_table_privilege(current_user,format('%I.%I',$1,c.relname),'INSERT')
                                  and has_table_privilege(current_user,format('%I.%I',$1,c.relname),'UPDATE')
                                  and has_table_privilege(current_user,format('%I.%I',$1,c.relname),'DELETE'))
                     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind in ('r','p')),false) as tables_ready,
         coalesce((select bool_and(has_column_privilege(current_user,c.oid,a.attnum,'SELECT')
                                  and has_column_privilege(current_user,c.oid,a.attnum,'INSERT')
                                  and has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
                                  and has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES'))
                     from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname=$1 and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped),false) as columns_ready,
         coalesce((select bool_and(has_sequence_privilege(current_user,format('%I.%I',$1,c.relname),'USAGE')
                                  and has_sequence_privilege(current_user,format('%I.%I',$1,c.relname),'SELECT')
                                  and has_sequence_privilege(current_user,format('%I.%I',$1,c.relname),'UPDATE'))
                     from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=$1 and c.relkind='S'),true) as sequences_ready,
         coalesce((select bool_and(has_function_privilege(current_user,p.oid,'EXECUTE'))
                     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname=$1),true) as functions_ready,
         exists(select 1 from pg_namespace n
                cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
                where n.nspname=$1 and a.grantee=0 and a.privilege_type='USAGE') as public_schema,
         exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
                where n.nspname=$1 and c.relkind in ('r','p') and a.grantee=0
                  and a.privilege_type in ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')) as public_tables,
         exists(select 1 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
                cross join lateral aclexplode(a.attacl) x
                where n.nspname=$1 and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped and x.grantee=0) as public_columns,
         exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                cross join lateral aclexplode(coalesce(c.relacl,acldefault('s',c.relowner))) a
                where n.nspname=$1 and c.relkind='S' and a.grantee=0 and a.privilege_type in ('USAGE','SELECT','UPDATE')) as public_sequences,
         exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
                where n.nspname=$1 and a.grantee=0 and a.privilege_type='EXECUTE') as public_functions,
         exists(
           select 1 from pg_namespace n
           cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
           where n.nspname=$1 and a.grantee not in (0,n.nspowner,(select oid from pg_roles where rolname=current_user))
           union all
           select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl,acldefault(case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner))) a
           where n.nspname=$1 and c.relkind in ('r','p','S') and a.grantee not in (0,c.relowner,(select oid from pg_roles where rolname=current_user))
           union all
           select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
           where n.nspname=$1 and a.grantee not in (0,p.proowner,(select oid from pg_roles where rolname=current_user))
           union all
           select 1 from pg_attribute at join pg_class c on c.oid=at.attrelid join pg_namespace n on n.oid=c.relnamespace
           cross join lateral aclexplode(at.attacl) a
           where n.nspname=$1 and c.relkind in ('r','p') and at.attnum>0 and not at.attisdropped
             and a.grantee not in (0,c.relowner,(select oid from pg_roles where rolname=current_user))
           limit 1
         ) as foreign_acl`,
      [VOICE_LAB_SCHEMA],
    );
    const access = privileges.rows[0];
    if (!access?.schema_usage || !access.tables_ready || !access.columns_ready || !access.sequences_ready || !access.functions_ready || access.public_schema || access.public_tables || access.public_columns || access.public_sequences || access.public_functions || access.foreign_acl) {
      return { ok: false, detail: "schema-privilege-mismatch", catalogSha256 };
    }
    if (dmlPostflight) {
      phase = "dml";
      await probeRuntimeDml(database);
    }
    return { ok: true, detail: "schema-attested", catalogSha256 };
  } catch (error) {
    const failedPhase = error instanceof SchemaAttestationPhaseError ? error.phase : phase;
    return { ok: false, detail: `schema-attestation-unavailable:${failedPhase}:${schemaAttestationFailureClass(error)}`, catalogSha256: null };
  }
}

class SchemaAttestationPhaseError extends Error {
  constructor(readonly phase: string, readonly source: unknown) { super(`Voice Lab schema attestation failed during ${phase}`); }
}

function schemaAttestationFailureClass(error: unknown): "concurrent-client-query" | "permission-denied" | "missing-schema-object" | "transaction-failed" | "database-query-failed" {
  const source = error instanceof SchemaAttestationPhaseError ? error.source : error;
  const message = source instanceof Error ? source.message.toLowerCase() : "";
  if (message.includes("client already executing") || message.includes("query overlap")) return "concurrent-client-query";
  if (message.includes("permission denied") || message.includes("must be owner")) return "permission-denied";
  if (message.includes("does not exist") || message.includes("undefined table") || message.includes("undefined column")) return "missing-schema-object";
  if (message.includes("transaction") || message.includes("current transaction is aborted")) return "transaction-failed";
  return "database-query-failed";
}

async function probeRuntimeDml(database: Queryable): Promise<void> {
  await phaseQuery(database, "dml-begin", "begin");
  try {
    await phaseQuery(database, "dml-select", `select singleton from ${VOICE_LAB_SCHEMA}.schema_metadata where singleton=true for key share`);
    const inserted = await phaseQuery<{ id: number }>(database, "dml-insert",
      `insert into ${VOICE_LAB_SCHEMA}.auth_audit (run_id,caller_id,caller_partition_id,action,argument_hash,outcome,detail,observed_at)
       values (null,null,'cp1:postflight:'||repeat('0',64),'schema:postflight',repeat('0',64),'allowed','{"content_free":true}'::jsonb,now()) returning id`,
    );
    await phaseQuery(database, "dml-delete", `delete from ${VOICE_LAB_SCHEMA}.auth_audit where id=$1`, [inserted.rows[0]!.id]);
  } finally {
    await phaseQuery(database, "dml-rollback", "rollback");
  }
}

async function phaseQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(database: Queryable, phase: string, sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
  try { return await database.query<T>(sql, params); }
  catch (error) { throw new SchemaAttestationPhaseError(phase, error); }
}
