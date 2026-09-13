import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect } from "vitest";
import { CallerPartitioner } from "../src/caller-partition.js";
import { BASE_MIGRATION_SHA256, composeVoiceLabMigration } from "../src/migration-bundle.js";
import { inventoryHistoricalRecovery } from "../src/recovery-backfill-inventory.js";
import { inventoryHistoricalQuarantine } from "../src/historical-quarantine-inventory.js";
import { upgradeHistoricalRecovery } from "../src/recovery-upgrade.js";
import { parseRecoveryUpgradeOperator, runRecoveryUpgradeOperator } from "../src/recovery-upgrade-operator.js";
import { readVoiceLabCatalog } from "../src/schema-attestation.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

/** Called only by the dedicated disposable-database suite, never a live runner. */
export async function proveHistoricalQuarantine(admin: pg.Client, databaseUrl: string, runMigration: (url: string) => Promise<void>) {
  await proveQuarantineVariant(admin, databaseUrl, runMigration, false);
  await proveQuarantineVariant(admin, databaseUrl, runMigration, true);
}

async function proveQuarantineVariant(admin: pg.Client, databaseUrl: string, runMigration: (url: string) => Promise<void>, accepted: boolean) {
  const target = new URL(databaseUrl);
  if (target.pathname !== "/voice_lab_test" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("Quarantine proof requires the named local disposable database");
  }
  const base = await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql");
  const extension = await readFile("migrations/004_recovery_controls.sql");
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const partitions = new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-quarantine-proof-key-000000000000000000" } });
  try {
    await admin.query(base.toString("utf8"));
    const oldCatalog = canonicalRequestHash(await readVoiceLabCatalog(admin));
    await admin.query("update sophia_voice_lab.schema_metadata set migration_sha256=$1,catalog_sha256=$2", [BASE_MIGRATION_SHA256, oldCatalog]);
    for (const [id, status] of [["a", "confirmed"], ["b", "unconfirmed"]]) {
      await admin.query(`insert into sophia_voice_lab.retention_tombstones values
        ($1,$2,$3,'2020-01-01T00:00:00Z','2020-02-01T00:00:00Z')`, [id!.repeat(64), (id === "a" ? "c" : "d").repeat(64), status]);
    }
    const inventory = await inventoryHistoricalRecovery(pool, partitions);
    expect(inventory.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
    const options = { expectedInventorySha256: inventory.inventorySha256!,
      ...(accepted ? { admissionExceptionAuthorizationSha256: "e".repeat(64) } : {}) };
    const reference = "sophia_voice_lab_ref_quarantine";
    await admin.query(composeVoiceLabMigration(base, extension).toString("utf8").replace(/\bsophia_voice_lab\b/g, reference));
    const targetCatalog = canonicalRequestHash(await readVoiceLabCatalog(admin, reference));
    await admin.query(`drop schema ${reference} cascade`);
    await expect(upgradeHistoricalRecovery(pool, partitions, extension, oldCatalog, targetCatalog)).rejects.toThrow("UPGRADE_ERASED_HISTORY_UNRECONCILED");
    await expect(upgradeHistoricalRecovery(pool, partitions, extension, oldCatalog, targetCatalog,
      { expectedInventorySha256: "f".repeat(64) })).rejects.toThrow("UPGRADE_QUARANTINE_INVENTORY_DRIFT");
    await expect(upgradeHistoricalRecovery(pool, partitions, extension, oldCatalog, "f".repeat(64), options)).rejects.toThrow("UPGRADE_POSTFLIGHT_DRIFT");
    expect((await admin.query("select to_regclass('sophia_voice_lab.historical_quarantine') as name")).rows[0].name).toBeNull();
    expect((await admin.query("select count(*)::int as n from sophia_voice_lab.retention_tombstones")).rows[0].n).toBe(2);
    const upgraded = accepted ? await runRecoveryUpgradeOperator(pool, parseRecoveryUpgradeOperator({
      DATABASE_URL: databaseUrl, COMMIT_SHA: "a".repeat(40),
      SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_EXPECTED_COMMIT: "a".repeat(40),
      SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_APPROVED: "YES", SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
      SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_INVENTORY_SHA256: options.expectedInventorySha256,
      SOPHIA_VOICE_LAB_RECOVERY_UPGRADE_AUTHORIZATION_SHA256: "e".repeat(64),
      SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: JSON.stringify({ active_key_id: "test",
        keys: { test: "synthetic-quarantine-proof-key-000000000000000000" } }),
    }), base, extension) : await upgradeHistoricalRecovery(pool, partitions, extension, oldCatalog, targetCatalog, options);
    expect(upgraded).toMatchObject({
      controlsBackfilled: 0, quarantinedIdentities: 2, allocationBlockedByQuarantine: !accepted, historicalCleanupProven: false,
      acceptedUnverifiedHistoricalIdentities: accepted ? 2 : 0,
    });
    expect(canonicalRequestHash(await readVoiceLabCatalog(admin))).toBe(targetCatalog);
    expect((await admin.query("select count(*)::int as n from pg_namespace where nspname like 'sophia_voice_lab_ref_%'")).rows[0].n).toBe(0);
    // Actual normal startup migration can attest without discarding quarantine.
    await runMigration(databaseUrl);
    const quarantinedLedger = new PostgresVoiceLabLedger(databaseUrl);
    try {
      if (accepted) {
        expect((await quarantinedLedger.health()).ok).toBe(true);
        const freshRun = testRun();
        const operation = { id: randomUUID(), runId: freshRun.id, callerId: freshRun.callerId,
          type: "start" as const, idempotencyKey: randomUUID(), requestHash: sha256(freshRun.id), input: {} };
        await quarantinedLedger.createRunWithOperation(freshRun, operation, { global: 1, caller: 1 });
        expect(await quarantinedLedger.getRun(freshRun.id)).toMatchObject({ id: freshRun.id });
        const second = testRun();
        await expect(quarantinedLedger.createRunWithOperation(second, { ...operation, id: randomUUID(), runId: second.id,
          idempotencyKey: randomUUID(), requestHash: sha256(second.id) }, { global: 1, caller: 1 }))
          .rejects.toMatchObject({ detail: { code: "CONCURRENCY_LIMIT" } });
      } else expect(await quarantinedLedger.health()).toEqual({ ok: false, detail: "historical-recovery-quarantined" });
    } finally { await quarantinedLedger.close(); }
    // Expiring source tombstones cannot erase the new durable unresolved control.
    await admin.query("delete from sophia_voice_lab.retention_tombstones where control_expires_at<now()");
    const diagnostic = await inventoryHistoricalQuarantine(pool);
    expect(diagnostic).toMatchObject({ quarantineCount: "2", enumerationComplete: true,
      historicalReconciliationRequired: true, cleanupProven: false, admissionAuthorized: false });
    expect(diagnostic.entries.map(row => row.sourceInventorySha256)).toEqual([options.expectedInventorySha256, options.expectedInventorySha256]);
    expect(diagnostic.entries.every(row => row.admissionDisposition === (accepted
      ? "operator_accepted_unverified_history" : "blocked_unverified_history"))).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain("a".repeat(64));
    expect(await inventoryHistoricalQuarantine(pool, 1)).toMatchObject({ quarantineCount: "2", enumerationComplete: false });
    const fresh = new pg.Client({ connectionString: databaseUrl });
    await fresh.connect();
    try {
      const preserved = await fresh.query("select lookup_id_hmac,inventory_sha256,remote_purge_status from sophia_voice_lab.historical_quarantine order by lookup_id_hmac");
      expect(preserved.rows).toEqual([
        { lookup_id_hmac: "a".repeat(64), inventory_sha256: options.expectedInventorySha256, remote_purge_status: "confirmed" },
        { lookup_id_hmac: "b".repeat(64), inventory_sha256: options.expectedInventorySha256, remote_purge_status: "unconfirmed" },
      ]);
      if (accepted) {
        const exceptions = await fresh.query("select count(*)::int as n from sophia_voice_lab.historical_admission_exceptions");
        expect(exceptions.rows[0].n).toBe(2);
        for (const sql of ["delete from sophia_voice_lab.historical_admission_exceptions",
          "update sophia_voice_lab.historical_admission_exceptions set inventory_sha256=repeat('f',64)",
          "truncate sophia_voice_lab.historical_admission_exceptions"]) {
          await expect(fresh.query(sql)).rejects.toThrow("HISTORICAL_QUARANTINE_IMMUTABLE");
        }
        // Acceptance is not a global bypass: a later identity in even the same
        // inventory has no per-row exception and immediately restores fencing.
        await fresh.query(`insert into sophia_voice_lab.historical_quarantine
          (lookup_id_hmac,recovery_id_hmac,inventory_sha256,remote_purge_status,source_purged_at,source_control_expires_at)
          values (repeat('f',64),repeat('e',64),$1,'unconfirmed','2020-01-01Z','2020-02-01Z')`, [options.expectedInventorySha256]);
      }
      for (const sql of [
        "insert into sophia_voice_lab.runs default values",
        "insert into sophia_voice_lab.suite_runs default values",
        "insert into sophia_voice_lab.browser_leases default values",
        "insert into sophia_voice_lab.operations(type) values ('start')",
        "insert into sophia_voice_lab.operations(type) values ('speak')",
        "insert into sophia_voice_lab.operations(type) values ('barge_in')",
        "insert into sophia_voice_lab.operations(type) values ('force_socket_rotation')",
      ]) await expect(fresh.query(sql)).rejects.toThrow("HISTORICAL_RECOVERY_QUARANTINED");
      for (const sql of [
        "delete from sophia_voice_lab.historical_quarantine",
        "update sophia_voice_lab.historical_quarantine set remote_purge_status='confirmed'",
        "truncate sophia_voice_lab.historical_quarantine cascade",
      ]) await expect(fresh.query(sql)).rejects.toThrow("HISTORICAL_QUARANTINE_IMMUTABLE");
    } finally { await fresh.end(); }
  } finally {
    await pool.end();
    await admin.query("drop schema if exists sophia_voice_lab_ref_quarantine cascade");
    await admin.query("drop schema if exists sophia_voice_lab cascade");
  }
}
