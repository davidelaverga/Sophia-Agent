import { createHash } from "node:crypto";
import type pg from "pg";
import type { CallerPartitioner } from "./caller-partition.js";
import { BASE_MIGRATION_SHA256, RECOVERY_MIGRATION_SHA256 } from "./migration-bundle.js";
import { decodeStoredVoiceLabRun } from "./postgres-ledger.js";
import { assessHistoricalRecovery } from "./recovery-backfill.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { historicalInventoryCommitment } from "./historical-inventory-commitment.js";
import { readVoiceLabCatalog, VOICE_LAB_TABLES, VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256 } from "./schema-attestation.js";

/** Staged upgrade primitive, deliberately NOT called by normal service startup.
 * The deployment controller must first close gates/quiesce old services and
 * derive both catalog hashes from the immutable release reference schemas.
 * This function never writes a host seal or changes external deployment gates. */
export async function upgradeHistoricalRecovery(pool: pg.Pool, partitions: CallerPartitioner, extension: Buffer,
  expectedV3CatalogSha256: string, expectedV4CatalogSha256: string,
  quarantine?: { expectedInventorySha256: string; admissionExceptionAuthorizationSha256?: string }) {
  if (quarantine && !/^[a-f0-9]{64}$/.test(quarantine.expectedInventorySha256)) throw new Error("UPGRADE_QUARANTINE_REFERENCE_INVALID");
  if (quarantine?.admissionExceptionAuthorizationSha256 !== undefined
    && !/^[a-f0-9]{64}$/.test(quarantine.admissionExceptionAuthorizationSha256)) throw new Error("UPGRADE_HISTORICAL_ACCEPTANCE_INVALID");
  if (![expectedV3CatalogSha256, expectedV4CatalogSha256].every(h => /^[a-f0-9]{64}$/.test(h))
    || createHash("sha256").update(extension).digest("hex") !== RECOVERY_MIGRATION_SHA256) throw new Error("UPGRADE_REFERENCE_INVALID");
  const marker = "-- Browser allocations belong to durable control, never to expiring content.";
  const parts = extension.toString("utf8").split(marker);
  if (parts.length !== 2) throw new Error("UPGRADE_EXTENSION_LAYOUT_INVALID");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    await client.query("select pg_advisory_xact_lock(hashtext('sophia_voice_lab_schema_v3'))");
    const tables = VOICE_LAB_TABLES.filter(t => !["recovery_controls", "historical_quarantine", "historical_admission_exceptions"].includes(t));
    await client.query(`lock table ${tables.map(t => `sophia_voice_lab.${t}`).join(",")} in access exclusive mode`);
    const metadata = await client.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    if (metadata.rows.length !== 1 || Number(metadata.rows[0].schema_version) !== 3 || metadata.rows[0].migration_sha256 !== BASE_MIGRATION_SHA256
      || canonicalRequestHash(await readVoiceLabCatalog(client)) !== expectedV3CatalogSha256) throw new Error("UPGRADE_SOURCE_DRIFT");
    const pending = await client.query(`select
      exists(select 1 from sophia_voice_lab.retention_tombstones) as erased_history,
      exists(select 1 from sophia_voice_lab.worker_heartbeats where observed_at>clock_timestamp()-interval '30 seconds') as workers,
      exists(select 1 from sophia_voice_lab.operations where state in ('accepted','queued','leased','executing')) as operations`);
    if (pending.rows[0].erased_history && !quarantine) throw new Error("UPGRADE_ERASED_HISTORY_UNRECONCILED");
    if (pending.rows[0].workers || pending.rows[0].operations) throw new Error("UPGRADE_NOT_QUIESCENT");
    const runs = await client.query("select * from sophia_voice_lab.runs order by id limit 1001");
    if (runs.rows.length > 1000) throw new Error("UPGRADE_INVENTORY_BOUND_EXCEEDED");
    // Quarantine is not a reconciled-history upgrade. This explicit lane is
    // limited to erased-only history, retains every opaque locator, and installs
    // a database allocation fence before commit. No caller/run/owner is invented.
    let erased: Array<Record<string, any>> = [];
    if (quarantine) {
      const leases = await client.query("select count(*)::text as count from sophia_voice_lab.browser_leases");
      if (runs.rows.length || leases.rows[0].count !== "0") throw new Error("UPGRADE_QUARANTINE_REQUIRES_ERASED_ONLY");
      erased = (await client.query("select * from sophia_voice_lab.retention_tombstones order by lookup_id_hmac limit 10001")).rows;
      if (!erased.length || erased.length > 10_000) throw new Error("UPGRADE_QUARANTINE_INVENTORY_BOUND");
      const inventory = historicalInventoryCommitment({
        sourceMigrationSha256: BASE_MIGRATION_SHA256, enumerationComplete: true,
        tombstoneEnumerationComplete: true, runCount: "0", browserLeaseCount: "0", entries: [],
        tombstoneCount: String(erased.length),
        unconfirmedTombstoneCount: String(erased.filter(r => r.remote_purge_status === "unconfirmed").length),
        tombstones: erased.map(r => ({ lookupIdSha256: sha256(r.lookup_id_hmac), recoveryIdSha256: sha256(r.recovery_id_hmac),
          remotePurgeStatus: r.remote_purge_status, purgedAt: new Date(r.purged_at).toISOString(),
          controlExpiresAt: new Date(r.control_expires_at).toISOString(), assessment: "independent_historical_reconciliation_required" })),
      });
      if (inventory !== quarantine.expectedInventorySha256) throw new Error("UPGRADE_QUARANTINE_INVENTORY_DRIFT");
    }
    const controls = [];
    for (const row of runs.rows) {
      const run = decodeStoredVoiceLabRun(row);
      const events = await client.query("select * from sophia_voice_lab.run_events where run_id=$1 order by seq limit 50001", [run.id]);
      if (events.rows.length > 50_000) throw new Error("UPGRADE_EVENT_BOUND_EXCEEDED");
      const leases = await client.query("select * from sophia_voice_lab.browser_leases where run_id=$1", [run.id]);
      const lease = leases.rows[0];
      const result = assessHistoricalRecovery({ run, callerPartitionId: partitions.activeCallerId(run.callerId),
        events: events.rows.map(e => ({ runId: e.run_id, seq: Number(e.seq), kind: e.kind, source: e.source, payload: e.payload, at: e.observed_at, dedupeKey: e.dedupe_key })),
        lease: lease ? { runId: lease.run_id, workerId: lease.worker_id, leaseEpoch: Number(lease.lease_epoch), expiresAt: lease.expires_at, updatedAt: lease.updated_at } : null });
      if (!result.ready) throw new Error(`UPGRADE_RECONCILIATION_REQUIRED:${result.reason}`);
      controls.push(result.control);
    }
    await client.query(parts[0]!);
    for (const row of erased) await client.query(`insert into sophia_voice_lab.historical_quarantine
      (lookup_id_hmac,recovery_id_hmac,inventory_sha256,remote_purge_status,source_purged_at,source_control_expires_at)
      values ($1,$2,$3,$4,$5,$6)`, [row.lookup_id_hmac,row.recovery_id_hmac,quarantine!.expectedInventorySha256,
      row.remote_purge_status,row.purged_at,row.control_expires_at]);
    // The authorization reference records an operator's risk acceptance, not a
    // signature or source proof. Only this exact locked historical inventory is
    // excepted. No runtime route can turn a new failed run into accepted history.
    if (quarantine?.admissionExceptionAuthorizationSha256) {
      for (const row of erased) await client.query(`insert into sophia_voice_lab.historical_admission_exceptions
        (lookup_id_hmac,inventory_sha256,authorization_sha256) values ($1,$2,$3)`,
      [row.lookup_id_hmac,quarantine.expectedInventorySha256,quarantine.admissionExceptionAuthorizationSha256]);
    }
    for (const c of controls) await client.query(`insert into sophia_voice_lab.recovery_controls
      (run_id,test_run_id,cleanup_obligation_id,binding,browser_allocation_ever,execution_ownership,execution_cleanup_proof,version,live_cleanup_complete,remote_purge_complete,retention_purge_due_at,browser_allocation_binding)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [c.binding.runId,c.binding.testRunId,c.binding.cleanupObligationId,c.binding,c.browserAllocationEver,c.executionOwnership ?? null,c.executionCleanupProof ?? null,c.version,c.liveCleanupComplete,c.remotePurgeComplete,c.retentionPurgeDueAt,c.browserAllocationBinding ?? null]);
    // FK transfer occurs only after every historical allocation has its parent.
    await client.query(parts[1]!);
    if (canonicalRequestHash(await readVoiceLabCatalog(client)) !== expectedV4CatalogSha256) throw new Error("UPGRADE_POSTFLIGHT_DRIFT");
    await client.query("update sophia_voice_lab.schema_metadata set schema_version=$1,migration_sha256=$2,catalog_sha256=$3,updated_at=now() where singleton=true",
      [VOICE_LAB_SCHEMA_VERSION, VOICE_LAB_MIGRATION_SHA256, expectedV4CatalogSha256]);
    await client.query("commit");
    return { schema: "sophia.voice-lab.v3-upgrade.v1", controlsBackfilled: controls.length,
      quarantinedIdentities: erased.length,
      acceptedUnverifiedHistoricalIdentities: quarantine?.admissionExceptionAuthorizationSha256 ? erased.length : 0,
      allocationBlockedByQuarantine: erased.length > 0 && !quarantine?.admissionExceptionAuthorizationSha256,
      historicalCleanupProven: false, catalogSha256: expectedV4CatalogSha256 };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
