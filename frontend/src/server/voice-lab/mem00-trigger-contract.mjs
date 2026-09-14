import { createHash } from 'node:crypto';

// Optional, independently shipped MEM00 migration. Never discard arbitrary
// companion triggers or weaken validation of the four Voice Lab write fences.
export const MEM00_DELETE_TRIGGER = 'sophia_mem00_ordinary_session_delete_order';
export const MEM00_DELETE_SOURCE_SHA256 =
  '4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce';

// Used by both the runtime and owner preflight, with their existing p alias.
// Supabase grants service_role EXECUTE by default; the reviewed migration
// preserves that non-grantable owner-issued grant, but revokes public/anon/auth.
export const MEM00_FUNCTION_AUTHORITY_SQL = `(
  p.prokind = 'f' AND p.pronargs = 0 AND p.pronargdefaults = 0
  AND p.proargmodes IS NULL AND p.prorettype = 'pg_catalog.trigger'::regtype
  AND NOT p.proretset AND NOT p.proisstrict AND NOT p.proleakproof
  AND p.proparallel = 'u'
  AND NOT EXISTS (
    SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
    WHERE acl.privilege_type <> 'EXECUTE' OR acl.grantor <> p.proowner
      OR (acl.grantee <> p.proowner AND (
        acl.grantee IS DISTINCT FROM to_regrole('service_role')::oid
        OR acl.is_grantable
      ))
  )
)`;

/** Validate the sole optional companion, then return every governed/unknown row. */
export function withoutAttestedMem00Trigger(rows) {
  const companions = rows.filter((row) => row.tgname === MEM00_DELETE_TRIGGER);
  if (companions.length > 1) throw new Error('MEM00 delete-order trigger is duplicated.');
  for (const row of companions) {
    if (row.tablename !== 'sophia_sessions' || row.tgenabled !== 'O'
      || row.proname !== MEM00_DELETE_TRIGGER || row.function_schema !== 'public'
      || row.function_is_public_identity !== true || row.owner_is_expected !== true
      || row.owner_matches_control !== true || row.prosecdef !== true
      || row.provolatile !== 'v' || row.lanname !== 'plpgsql'
      || row.mem00_function_authority_valid !== true
      || !Array.isArray(row.proconfig) || row.proconfig.length !== 1
      || row.proconfig[0] !== 'search_path=pg_catalog, public'
      || row.trigger_definition !== `CREATE TRIGGER ${MEM00_DELETE_TRIGGER} BEFORE DELETE ON sophia_sessions FOR EACH ROW EXECUTE FUNCTION ${MEM00_DELETE_TRIGGER}()`
      || typeof row.prosrc !== 'string'
      || createHash('sha256').update(row.prosrc, 'utf8').digest('hex') !== MEM00_DELETE_SOURCE_SHA256) {
      throw new Error('MEM00 delete-order trigger contract drifted.');
    }
  }
  return rows.filter((row) => row.tgname !== MEM00_DELETE_TRIGGER);
}
