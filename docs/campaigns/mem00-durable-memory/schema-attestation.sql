-- Read-only, single-statement catalog snapshot. No application text is read.
-- Domain: public MEM00 relations/functions, session/message source relations,
-- their columns/constraints/indexes/triggers/policies, public enums/default
-- privileges, and the browser/service roles that affect this surface.
WITH targets AS (
  SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
    AND (c.relname LIKE 'sophia_memory_%' OR c.relname IN ('sophia_memories','sophia_sessions','sophia_session_messages'))
), items AS (
  SELECT 'relation'::text AS kind,c.relname::text AS identity,
    jsonb_build_object('kind',c.relkind::text,'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'view',CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,true) ELSE NULL END)::text AS payload
  FROM targets c
  UNION ALL
  SELECT 'column',c.relname||'.'||a.attname,
    jsonb_build_object('position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text)::text
  FROM targets c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  UNION ALL
  SELECT 'constraint',c.relname||'.'||k.conname,jsonb_build_object('definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated)::text
  FROM targets c JOIN pg_constraint k ON k.conrelid=c.oid
  UNION ALL
  SELECT 'index',c.relname||'.'||i.indexrelid::regclass::text,jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready)::text
  FROM targets c JOIN pg_index i ON i.indrelid=c.oid
  UNION ALL
  SELECT 'trigger',c.relname||'.'||t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled::text)::text
  FROM targets c JOIN pg_trigger t ON t.tgrelid=c.oid AND NOT t.tgisinternal
  UNION ALL
  SELECT 'policy',p.tablename||'.'||p.policyname,to_jsonb(p)::text
  FROM pg_policies p WHERE p.schemaname='public' AND p.tablename IN (SELECT relname FROM targets)
  UNION ALL
  SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
    jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),'acl',p.proacl::text,'config',p.proconfig,'security_definer',p.prosecdef)::text
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind IN ('f','p') AND (
    p.proname LIKE 'sophia_memory_%' OR p.oid IN (SELECT t.tgfoid FROM pg_trigger t JOIN targets c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal))
  UNION ALL
  SELECT 'enum',t.typname||'.'||e.enumsortorder::text,to_jsonb(e.enumlabel)::text
  FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'schema_acl',n.nspname,jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text)::text
  FROM pg_namespace n WHERE n.nspname='public'
  UNION ALL
  SELECT 'default_acl',pg_get_userbyid(d.defaclrole)||'.'||d.defaclobjtype::text,d.defaclacl::text
  FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'role',r.rolname,jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'bypass_rls',r.rolbypassrls,'login',r.rolcanlogin)::text
  FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role')
), groups AS (
  SELECT kind,count(*) AS item_count,encode(sha256(convert_to(string_agg(identity||E'\n'||payload,E'\n' ORDER BY identity,payload),'UTF8')),'hex') AS sha256
  FROM items GROUP BY kind
)
SELECT jsonb_build_object(
  'observed_at',statement_timestamp(),
  'domain','mem00.catalog-surface.v1',
  'item_count',(SELECT count(*) FROM items),
  'sha256',(SELECT encode(sha256(convert_to(string_agg(kind||E'\n'||identity||E'\n'||payload,E'\n' ORDER BY kind,identity,payload),'UTF8')),'hex') FROM items),
  'groups',(SELECT jsonb_agg(to_jsonb(g) ORDER BY kind) FROM groups g),
  'contract',(SELECT jsonb_build_object('schema_version',schema_version,'contract_epoch',contract_epoch,'mode',mode) FROM public.sophia_memory_contract WHERE singleton=true),
  'application_rows_read',0,
  'mutations',0
) AS mem00_schema_attestation;
