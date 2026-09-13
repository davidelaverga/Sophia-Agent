import type pg from "pg";
import type { CallerPartitioner } from "./caller-partition.js";
import { BASE_MIGRATION_SHA256 } from "./migration-bundle.js";
import { decodeStoredVoiceLabRun } from "./postgres-ledger.js";
import { assessHistoricalRecovery } from "./recovery-backfill.js";
import { canonicalRequestHash, sha256 } from "./security.js";
import { historicalInventoryCommitment } from "./historical-inventory-commitment.js";

/** One consistent read-only v3 snapshot. Reports hashes/counts only; never
 * returns run content, grants, provider identifiers, or a DDL authorization. */
export async function inventoryHistoricalRecovery(pool: pg.Pool, partitions: CallerPartitioner, maxRuns = 1000, maxEventsPerRun = 10_000, maxTombstones = 1000) {
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000
    || !Number.isSafeInteger(maxEventsPerRun) || maxEventsPerRun < 1 || maxEventsPerRun > 50_000
    || !Number.isSafeInteger(maxTombstones) || maxTombstones < 1 || maxTombstones > 10_000) throw new Error("Historical inventory bounds invalid");
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '15s'");
    const metadata = await client.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata where singleton=true");
    if (metadata.rows.length !== 1 || Number(metadata.rows[0].schema_version) !== 3 || metadata.rows[0].migration_sha256 !== BASE_MIGRATION_SHA256) throw new Error("Historical inventory requires the exact v3 migration identity");
    const totals = await client.query(`select
      (select count(*)::text from sophia_voice_lab.runs) as runs,
      (select count(*)::text from sophia_voice_lab.browser_leases) as leases,
      (select count(*)::text from sophia_voice_lab.retention_tombstones) as tombstones,
      (select count(*)::text from sophia_voice_lab.retention_tombstones where remote_purge_status='unconfirmed') as unconfirmed_tombstones,
      transaction_timestamp() as observed_at`);
    const rows = await client.query("select * from sophia_voice_lab.runs order by id limit $1", [maxRuns + 1]);
    const entries: Array<{ runIdSha256: string; assessment: string; controlSha256?: string; liveCleanupComplete?: boolean }> = [];
    for (const row of rows.rows.slice(0, maxRuns)) {
      const run = decodeStoredVoiceLabRun(row);
      const storedEvents = await client.query(`select * from sophia_voice_lab.run_events where run_id=$1
        and kind=any($2::text[]) order by seq limit $3`, [run.id,
        ["harness.browser_process_acquired", "harness.browser_runtime_acquired", "cleanup.browser_context_closed", "cleanup.provider_transport_closed", "auth.session_cleanup", "cleanup.recovery"], maxEventsPerRun + 1]);
      if (storedEvents.rows.length > maxEventsPerRun) {
        entries.push({ runIdSha256: sha256(run.id), assessment: "historical_event_bound_exceeded" });
        continue;
      }
      const leases = await client.query("select * from sophia_voice_lab.browser_leases where run_id=$1", [run.id]);
      const lease = leases.rows[0];
      const result = assessHistoricalRecovery({ run, callerPartitionId: partitions.activeCallerId(run.callerId),
        events: storedEvents.rows.map(e => ({ runId: e.run_id, seq: Number(e.seq), kind: e.kind, source: e.source, payload: e.payload, at: e.observed_at, dedupeKey: e.dedupe_key })),
        lease: lease ? { runId: lease.run_id, workerId: lease.worker_id, leaseEpoch: Number(lease.lease_epoch), expiresAt: lease.expires_at, updatedAt: lease.updated_at } : null });
      entries.push(result.ready
        ? { runIdSha256: sha256(run.id), assessment: "control_projectable", controlSha256: canonicalRequestHash(result.control), liveCleanupComplete: result.control.liveCleanupComplete }
        : { runIdSha256: result.runIdSha256, assessment: result.reason });
    }
    const counts = totals.rows[0];
    // Even zero retained runs can leave remote obligations. Keep each erased
    // identity distinguishable without exporting the original keyed lookup IDs.
    const erased = await client.query(`select lookup_id_hmac,recovery_id_hmac,remote_purge_status,purged_at,control_expires_at
      from sophia_voice_lab.retention_tombstones order by lookup_id_hmac limit $1`, [maxTombstones + 1]);
    const tombstones = erased.rows.slice(0, maxTombstones).map(row => {
      const purgedAt = new Date(row.purged_at).toISOString();
      const controlExpiresAt = new Date(row.control_expires_at).toISOString();
      if (!/^[a-f0-9]{64}$/.test(row.lookup_id_hmac) || !/^[a-f0-9]{64}$/.test(row.recovery_id_hmac)
        || !["confirmed", "unconfirmed"].includes(row.remote_purge_status)
        || controlExpiresAt <= purgedAt) throw new Error("Historical tombstone invalid");
      return { lookupIdSha256: sha256(row.lookup_id_hmac), recoveryIdSha256: sha256(row.recovery_id_hmac),
        remotePurgeStatus: row.remote_purge_status as "confirmed" | "unconfirmed", purgedAt, controlExpiresAt,
        assessment: "independent_historical_reconciliation_required" as const };
    });
    const tombstoneEnumerationComplete = erased.rows.length <= maxTombstones;
    const report = { schema: "sophia.voice-lab.v3-recovery-inventory.v1", upgradeAuthorized: false,
      observedAt: new Date(counts.observed_at).toISOString(), sourceMigrationSha256: BASE_MIGRATION_SHA256,
      runCount: String(counts.runs), browserLeaseCount: String(counts.leases), tombstoneCount: String(counts.tombstones),
      unconfirmedTombstoneCount: String(counts.unconfirmed_tombstones),
      tombstoneEnumerationComplete, tombstones,
      enumerationComplete: rows.rows.length <= maxRuns && tombstoneEnumerationComplete && entries.every(e => e.assessment !== "historical_event_bound_exceeded"),
      historicalReconciliationRequired: counts.tombstones !== "0" || entries.some(e => e.assessment !== "control_projectable") || rows.rows.length > maxRuns,
      entries };
    const inventorySha256 = report.enumerationComplete ? historicalInventoryCommitment({
      sourceMigrationSha256: report.sourceMigrationSha256, enumerationComplete: report.enumerationComplete,
      tombstoneEnumerationComplete: report.tombstoneEnumerationComplete, runCount: report.runCount,
      browserLeaseCount: report.browserLeaseCount, tombstoneCount: report.tombstoneCount,
      unconfirmedTombstoneCount: report.unconfirmedTombstoneCount, entries, tombstones,
    }) : null;
    const committedReport = { ...report, inventorySha256 };
    await client.query("commit");
    return { ...committedReport, reportSha256: canonicalRequestHash(committedReport) };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
