import { createHash } from 'node:crypto';

// Optional, independently shipped MEM00 migrations. Never discard arbitrary
// companion triggers or weaken validation of the four Voice Lab write fences.
//
// Every trigger named here is attested against an exact pin set before it is
// removed from the governed set. Anything not named here stays in the returned
// rows, so the caller's `length !== EXPECTED_*.size` check still rejects it.
// Presence is optional in both directions: these migrations may or may not have
// been applied, so an absent companion is not an error, but a present one that
// does not match its pin exactly is.
export const MEM00_DELETE_TRIGGER = 'sophia_mem00_ordinary_session_delete_order';
export const MEM00_DELETE_SOURCE_SHA256 =
  '4087a488f957a0fb77d758de1db94f9938644411103ecfc77c62f5b9664716ce';

// MEM00 C1 source-intake companions on sophia_session_messages. Shipped by
// 2026_09_09_mem00_c1_{transactional_clear,dependency_authority,source_intake}.sql.
// Unlike the delete-order companion these are SECURITY INVOKER and their
// function name is not the trigger name, so both are pinned separately.
export const MEM00_SOURCE_ACCEPTANCE_EPOCH_TRIGGER = 'sophia_memory_source_acceptance_epoch';
export const MEM00_SOURCE_ACCEPTANCE_EPOCH_SOURCE_SHA256 =
  'b17c97cb0ff43cc2886c91167f3892e55dbf81d901749b7489eb8b20dff88f78';
export const MEM00_SOURCE_VERSION_TRIGGER = 'sophia_memory_source_version';
export const MEM00_SOURCE_VERSION_SOURCE_SHA256 =
  '3698f8af3e80860903d7600709eae539ac38a955ac54f1e396856f938dbe38a1';
export const MEM00_SOURCE_INTAKE_VERSION_TRIGGER = 'zz_mem00_source_intake_version';
export const MEM00_SOURCE_INTAKE_VERSION_SOURCE_SHA256 =
  '5234c90212fde254bdf0876ea11891857c6d9a4612f14b7193c5af348f2ba095';

const MEM00_SOURCE_MESSAGE_TABLE = 'sophia_session_messages';

function sourceIntakeCompanion(triggerName, functionName, sourceSha256) {
  return [triggerName, {
    table: MEM00_SOURCE_MESSAGE_TABLE,
    functionName,
    securityDefiner: false,
    sourceSha256,
    definition:
      `CREATE TRIGGER ${triggerName} BEFORE INSERT OR UPDATE ON ${MEM00_SOURCE_MESSAGE_TABLE}`
      + ` FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
  }];
}

/** Exact pin per attested companion. Anything absent here is never filtered. */
const MEM00_ATTESTED_TRIGGERS = new Map([
  [MEM00_DELETE_TRIGGER, {
    table: 'sophia_sessions',
    functionName: MEM00_DELETE_TRIGGER,
    securityDefiner: true,
    sourceSha256: MEM00_DELETE_SOURCE_SHA256,
    definition:
      `CREATE TRIGGER ${MEM00_DELETE_TRIGGER} BEFORE DELETE ON sophia_sessions`
      + ` FOR EACH ROW EXECUTE FUNCTION ${MEM00_DELETE_TRIGGER}()`,
  }],
  sourceIntakeCompanion(
    MEM00_SOURCE_ACCEPTANCE_EPOCH_TRIGGER,
    'sophia_memory_source_acceptance_epoch_trigger',
    MEM00_SOURCE_ACCEPTANCE_EPOCH_SOURCE_SHA256,
  ),
  sourceIntakeCompanion(
    MEM00_SOURCE_VERSION_TRIGGER,
    'sophia_memory_source_version_trigger',
    MEM00_SOURCE_VERSION_SOURCE_SHA256,
  ),
  sourceIntakeCompanion(
    MEM00_SOURCE_INTAKE_VERSION_TRIGGER,
    'sophia_memory_source_intake_version_trigger',
    MEM00_SOURCE_INTAKE_VERSION_SOURCE_SHA256,
  ),
]);

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

function companionMatchesPin(row, pin) {
  return row.tablename === pin.table
    && row.tgenabled === 'O'
    && row.proname === pin.functionName
    && row.function_schema === 'public'
    && row.function_is_public_identity === true
    && row.owner_is_expected === true
    && row.owner_matches_control === true
    && row.prosecdef === pin.securityDefiner
    && row.provolatile === 'v'
    && row.lanname === 'plpgsql'
    && row.mem00_function_authority_valid === true
    && Array.isArray(row.proconfig)
    && row.proconfig.length === 1
    && row.proconfig[0] === 'search_path=pg_catalog, public'
    && row.trigger_definition === pin.definition
    && typeof row.prosrc === 'string'
    && createHash('sha256').update(row.prosrc, 'utf8').digest('hex') === pin.sourceSha256;
}

/** Validate each attested companion, then return every governed/unknown row. */
export function withoutAttestedMem00Trigger(rows) {
  for (const [triggerName, pin] of MEM00_ATTESTED_TRIGGERS) {
    const companions = rows.filter((row) => row.tgname === triggerName);
    if (companions.length > 1) {
      throw new Error(`MEM00 companion trigger ${triggerName} is duplicated.`);
    }
    for (const row of companions) {
      if (!companionMatchesPin(row, pin)) {
        throw new Error(`MEM00 companion trigger ${triggerName} contract drifted.`);
      }
    }
  }
  return rows.filter((row) => !MEM00_ATTESTED_TRIGGERS.has(row.tgname));
}
