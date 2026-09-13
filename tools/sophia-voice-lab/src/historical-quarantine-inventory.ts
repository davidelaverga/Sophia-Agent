import type pg from "pg";
import { z } from "zod";
import { VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256 } from "./schema-attestation.js";
import { canonicalRequestHash, sha256 } from "./security.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({
  lookup_id_hmac: hash, recovery_id_hmac: hash, inventory_sha256: hash,
  remote_purge_status: z.enum(["confirmed", "unconfirmed"]),
  source_purged_at: z.coerce.date(), source_control_expires_at: z.coerce.date(),
  quarantined_at: z.coerce.date(),
  acceptance_authorization_sha256: hash.nullish(),
}).refine(row => row.source_control_expires_at > row.source_purged_at);

/** Diagnostic snapshot only. It neither authenticates an external settlement
 * nor certifies the database catalog, cleanup, or permission to open gates.
 * Read the durable quarantine, never its potentially expired source tombstones. */
export async function inventoryHistoricalQuarantine(pool: pg.Pool, maxRows = 1000) {
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 10_000) throw new Error("QUARANTINE_INVENTORY_BOUND_INVALID");
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '15s'");
    const metadata = await client.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    if (metadata.rows.length !== 1 || Number(metadata.rows[0].schema_version) !== VOICE_LAB_SCHEMA_VERSION
      || metadata.rows[0].migration_sha256 !== VOICE_LAB_MIGRATION_SHA256) throw new Error("QUARANTINE_INVENTORY_SOURCE_DRIFT");
    const counts = await client.query("select count(*)::text as count, transaction_timestamp() as observed_at from sophia_voice_lab.historical_quarantine");
    const count = z.string().regex(/^(0|[1-9][0-9]*)$/).parse(counts.rows[0]?.count);
    const rows = await client.query(`select lookup_id_hmac,recovery_id_hmac,inventory_sha256,remote_purge_status,
      source_purged_at,source_control_expires_at,quarantined_at,
      (select authorization_sha256 from sophia_voice_lab.historical_admission_exceptions e
        where e.lookup_id_hmac=q.lookup_id_hmac and e.inventory_sha256=q.inventory_sha256) as acceptance_authorization_sha256
      from sophia_voice_lab.historical_quarantine q order by lookup_id_hmac limit $1`, [maxRows + 1]);
    const parsed = rows.rows.map(row => rowSchema.parse(row));
    if (new Set(parsed.map(row => row.lookup_id_hmac)).size !== parsed.length
      || BigInt(parsed.length) !== (BigInt(count) < BigInt(maxRows + 1) ? BigInt(count) : BigInt(maxRows + 1))) {
      throw new Error("QUARANTINE_INVENTORY_INCONSISTENT");
    }
    const report = {
      schema: "sophia.voice-lab.historical-quarantine-inventory.v1",
      observedAt: z.coerce.date().parse(counts.rows[0].observed_at).toISOString(),
      sourceMigrationSha256: VOICE_LAB_MIGRATION_SHA256,
      quarantineCount: count, enumerationComplete: BigInt(count) <= BigInt(maxRows),
      historicalReconciliationRequired: count !== "0",
      cleanupProven: false, admissionAuthorized: false, upgradeAuthorized: false,
      entries: parsed.slice(0, maxRows).map(row => ({
        lookupIdSha256: sha256(row.lookup_id_hmac), recoveryIdSha256: sha256(row.recovery_id_hmac),
        sourceInventorySha256: row.inventory_sha256, remotePurgeStatus: row.remote_purge_status,
        sourcePurgedAt: row.source_purged_at.toISOString(), sourceControlExpiresAt: row.source_control_expires_at.toISOString(),
        quarantinedAt: row.quarantined_at.toISOString(), assessment: "independent_historical_reconciliation_required",
        admissionDisposition: row.acceptance_authorization_sha256 ? "operator_accepted_unverified_history" : "blocked_unverified_history",
        acceptanceAuthorizationSha256: row.acceptance_authorization_sha256 ?? null,
      })),
    };
    await client.query("commit");
    return { ...report, reportSha256: canonicalRequestHash(report) };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
