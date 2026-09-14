import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OAuthAccessTokenRecord, OAuthAuthorizationCodeRecord, OAuthAuthorizationRequestRecord, OAuthRefreshTokenRecord } from "../src/oauth.js";
import { PostgresOAuthLedgerStore } from "../src/oauth-postgres-store.js";
import { PostgresVoiceLabLedger, LEDGER_CONNECT_TIMEOUT_MS, LEDGER_STATEMENT_TIMEOUT_MS, LEDGER_LOCK_TIMEOUT_MS } from "../src/postgres-ledger.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { labError } from "../src/domain.js";
import { BASE_MIGRATION_SHA256, composeVoiceLabMigration } from "../src/migration-bundle.js";
import { upgradeHistoricalRecovery } from "../src/recovery-upgrade.js";
import { readVoiceLabCatalog } from "../src/schema-attestation.js";
import { testRun } from "./helpers.js";
import { inventoryHistoricalRecovery } from "../src/recovery-backfill-inventory.js";
import { CallerPartitioner } from "../src/caller-partition.js";
import { retentionHmac } from "../src/retention-identity.js";
import { joinHistoricalObligations } from "../src/historical-obligation-join.js";
import { deriveRecoveryBrowserBinding } from "../src/recovery-control.js";
import { verifyPreservedExecutionCleanup } from "./recovery-execution-persistence-helper.js";
import { verifyRecoveredLeaseRelease } from "./recovered-lease-helper.js";
import { completeExecutionCleanupFixture } from "./execution-cleanup-fixture.js";
import { deriveD02BrowserContextBinding } from "../src/worker.js";
import { proveP01LiveBoundary } from "./p01-live-boundary-helper.js";
import { proveHistoricalQuarantine } from "./historical-quarantine-postgres-helper.js";
import { verifyD02JournalDurability } from "./d02-journal-helper.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const databaseUrl = process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_URL?.trim() ?? "";
const describePostgres = databaseUrl ? describe : describe.skip;
const namespace = randomUUID();
let ledger: PostgresVoiceLabLedger | undefined;
let oauth: PostgresOAuthLedgerStore | undefined;

/**
 * This suite is intentionally opt-in and destructive only to a database whose
 * name explicitly contains `voice_lab_test`. It is designed to run inside the
 * web/worker image against an isolated preview database; it never contacts the
 * product, browser, TTS, Gateway, or provider planes.
 */
describePostgres("real PostgreSQL Voice Lab adapter", () => {
  beforeAll(async () => {
    assertDedicatedTestDatabase(databaseUrl);
    const admin = new Client({ connectionString: databaseUrl, application_name: "voice-lab-pg-test-reset" });
    await admin.connect();
    try {
      await admin.query("drop schema if exists sophia_voice_lab cascade");
      await admin.query("create schema sophia_voice_lab");
      await admin.query("create table sophia_voice_lab.runs (id text primary key)");
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await admin.query("drop schema sophia_voice_lab cascade");
      // Until backfill is implemented, v4 must refuse an exact populated v3
      // catalog without changing or discarding its historical run/obligation.
      await admin.query(await readFile(path.resolve(process.cwd(), "../../backend/migrations/2026_08_23_sophia_voice_lab.sql"), "utf8"));
      const oldCatalog = canonicalRequestHash(await readVoiceLabCatalog(admin));
      await admin.query("update sophia_voice_lab.schema_metadata set schema_version=3,migration_sha256=$1,catalog_sha256=$2", [BASE_MIGRATION_SHA256, oldCatalog]);
      const oldAdapter = new PostgresVoiceLabLedger(databaseUrl);
      const historical = testRun();
      try {
        // Seed the historical v3 storage format directly; the current adapter
        // now requires v4 controls and must not be used to fabricate old data.
        await admin.query(`insert into sophia_voice_lab.runs
          (id,caller_id,principal_id,test_run_id,cleanup_obligation_id,environment,state,target,capture_policy,verdicts,expires_at,created_at,updated_at,cleanup_complete)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [historical.id,historical.callerId,historical.principalId,historical.testRunId,historical.cleanupObligationId,historical.environment,historical.state,historical.target,historical.capturePolicy,historical.verdicts,historical.expiresAt,historical.createdAt,historical.updatedAt,historical.cleanupComplete]);
        await admin.query("insert into sophia_voice_lab.retention_tombstones values ($1,$2,'unconfirmed',now(),now()+interval '1 hour')", ["a".repeat(64), "b".repeat(64)]);
        const beforeInventory = await admin.query("select row_to_json(r) as row from sophia_voice_lab.runs r");
        const report = await inventoryHistoricalRecovery(oldAdapter.pool, new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } }));
        expect(report).toMatchObject({ upgradeAuthorized: false, enumerationComplete: true, historicalReconciliationRequired: true,
          runCount: "1", tombstoneCount: "1", unconfirmedTombstoneCount: "1", entries: [{ runIdSha256: sha256(historical.id), assessment: "historical_allocation_unknown" }],
          tombstoneEnumerationComplete: true, tombstones: [{ lookupIdSha256: sha256("a".repeat(64)), recoveryIdSha256: sha256("b".repeat(64)),
            remotePurgeStatus: "unconfirmed", assessment: "independent_historical_reconciliation_required" }] });
        expect(JSON.stringify(report)).not.toContain(historical.id);
        expect(JSON.stringify(report)).not.toContain(historical.callerId);
        expect(report.inventorySha256).toMatch(/^[a-f0-9]{64}$/);
        const joinKey = "synthetic-historical-join-key-00000000000000";
        const joinPartitions = new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } });
        await admin.query("insert into sophia_voice_lab.retention_tombstones values ($1,$2,'unconfirmed',now(),now()+interval '1 hour')",
          ["d".repeat(64), retentionHmac(joinKey, "recovery", historical.cleanupObligationId)]);
        const joinedInventory = await inventoryHistoricalRecovery(oldAdapter.pool, joinPartitions);
        const repeatedInventory = await inventoryHistoricalRecovery(oldAdapter.pool, joinPartitions);
        expect(joinedInventory.inventorySha256).toBe(repeatedInventory.inventorySha256);
        expect(joinedInventory.inventorySha256).not.toBe(report.inventorySha256);
        const { sourceMigrationSha256, enumerationComplete, tombstoneEnumerationComplete, runCount, browserLeaseCount,
          tombstoneCount, unconfirmedTombstoneCount, entries, tombstones } = joinedInventory;
        const joined = joinHistoricalObligations({ sourceMigrationSha256, enumerationComplete, tombstoneEnumerationComplete,
          runCount, browserLeaseCount, tombstoneCount, unconfirmedTombstoneCount, entries, tombstones }, [historical.cleanupObligationId], joinKey);
        expect(joined.inventorySha256).toBe(joinedInventory.inventorySha256);
        expect(joined.entries).toEqual([{ cleanupObligationIdSha256: sha256(historical.cleanupObligationId), status: "keyed_identity_match",
          lookupIdSha256: sha256("d".repeat(64)), recoveryIdSha256: sha256(retentionHmac(joinKey, "recovery", historical.cleanupObligationId)) }]);
        expect(joined.unmatchedTombstones).toEqual([sha256("a".repeat(64))]);
        expect(joined.upgradeAuthorized).toBe(false);
        await admin.query("delete from sophia_voice_lab.retention_tombstones where lookup_id_hmac=$1", ["d".repeat(64)]);
        const cli = await execFileAsync(process.execPath, ["--import", "tsx", "src/bin/recovery-inventory.ts"], {
          env: { ...process.env, DATABASE_URL: databaseUrl,
            SOPHIA_VOICE_LAB_CALLER_PARTITION_KEYS_JSON: JSON.stringify({ active_key_id: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } }) }, timeout: 30_000 });
        expect(cli.stderr).toBe("");
        expect(JSON.parse(cli.stdout)).toMatchObject({ upgradeAuthorized: false, enumerationComplete: true, historicalReconciliationRequired: true,
          runCount: "1", tombstoneCount: "1", unconfirmedTombstoneCount: "1", entries: report.entries });
        expect(cli.stdout).not.toContain(historical.id);
        expect((await admin.query("select row_to_json(r) as row from sophia_voice_lab.runs r")).rows).toEqual(beforeInventory.rows);
        expect((await admin.query("select count(*)::int as count from sophia_voice_lab.retention_tombstones")).rows[0].count).toBe(1);
        await admin.query("insert into sophia_voice_lab.retention_tombstones values ($1,$2,'confirmed',now(),now()+interval '1 hour')", ["c".repeat(64), "d".repeat(64)]);
        const erasedBounded = await inventoryHistoricalRecovery(oldAdapter.pool, new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } }), 1000, 10_000, 1);
        expect(erasedBounded).toMatchObject({ enumerationComplete: false, tombstoneEnumerationComplete: false,
          tombstoneCount: "2", unconfirmedTombstoneCount: "1", upgradeAuthorized: false, historicalReconciliationRequired: true });
        expect(erasedBounded.tombstones).toHaveLength(1);
        expect(erasedBounded.entries).toEqual(report.entries);
        expect(erasedBounded.tombstones[0]!.lookupIdSha256).toBe(sha256("a".repeat(64)));
        await admin.query("delete from sophia_voice_lab.retention_tombstones where lookup_id_hmac=$1", ["c".repeat(64)]);
        await admin.query("insert into sophia_voice_lab.run_events (run_id,seq,kind,source,payload,observed_at) values ($1,1,'harness.browser_process_acquired','browser','{}',now()),($1,2,'harness.browser_runtime_acquired','canonical','{}',now())", [historical.id]);
        const bounded = await inventoryHistoricalRecovery(oldAdapter.pool, new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-inventory-key-000000000000000000" } }), 1, 1);
        expect(bounded).toMatchObject({ upgradeAuthorized: false, enumerationComplete: false, historicalReconciliationRequired: true,
          entries: [{ runIdSha256: sha256(historical.id), assessment: "historical_event_bound_exceeded" }] });
        await expect(runMigration(databaseUrl)).rejects.toThrow(/pre-existing schema drift/);
        expect(await oldAdapter.getRun(historical.id)).toMatchObject({ cleanupObligationId: historical.cleanupObligationId, state: historical.state });
        expect((await admin.query("select to_regclass('sophia_voice_lab.recovery_controls') as name")).rows[0].name).toBeNull();
        expect(canonicalRequestHash(await readVoiceLabCatalog(admin))).toBe(oldCatalog);
        const extension = await readFile("migrations/004_recovery_controls.sql");
        const base = await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql");
        const reference = "sophia_voice_lab_ref_upgrade";
        await admin.query(composeVoiceLabMigration(base, extension).toString("utf8").replace(/\bsophia_voice_lab\b/g, reference));
        const targetCatalog = canonicalRequestHash(await readVoiceLabCatalog(admin, reference));
        await admin.query(`drop schema ${reference} cascade`);
        const partitions = new CallerPartitioner({ activeKeyId: "test", keys: { test: "synthetic-upgrade-key-000000000000000000" } });
        await expect(upgradeHistoricalRecovery(oldAdapter.pool, partitions, extension, oldCatalog, targetCatalog)).rejects.toThrow("UPGRADE_ERASED_HISTORY_UNRECONCILED");
        await admin.query("delete from sophia_voice_lab.retention_tombstones where lookup_id_hmac=$1", ["a".repeat(64)]);
        await expect(upgradeHistoricalRecovery(oldAdapter.pool, partitions, extension, oldCatalog, targetCatalog)).rejects.toThrow("historical_allocation_unknown");
        await admin.query("insert into sophia_voice_lab.worker_heartbeats (worker_id,service_version,browser_ready) values ('upgrade-test-worker','test',false)");
        await expect(upgradeHistoricalRecovery(oldAdapter.pool, partitions, extension, oldCatalog, targetCatalog)).rejects.toThrow("UPGRADE_NOT_QUIESCENT");
        await admin.query("delete from sophia_voice_lab.worker_heartbeats where worker_id='upgrade-test-worker'");
        await admin.query("insert into sophia_voice_lab.browser_leases values ($1,'historical-lost-owner',7,now()-interval '1 minute',now())", [historical.id]);
        await admin.query("update sophia_voice_lab.runs set state='completed',cleanup_complete=true where id=$1", [historical.id]);
        const preservedRun = (await admin.query("select row_to_json(r) as row from sophia_voice_lab.runs r")).rows;
        const preservedLease = (await admin.query("select row_to_json(r) as row from sophia_voice_lab.browser_leases r")).rows;
        const preservedEvents = (await admin.query("select row_to_json(r) as row from sophia_voice_lab.run_events r order by seq")).rows;
        // Force failure after DDL/backfill to prove transaction-wide rollback.
        await expect(upgradeHistoricalRecovery(oldAdapter.pool, partitions, extension, oldCatalog, "f".repeat(64))).rejects.toThrow("UPGRADE_POSTFLIGHT_DRIFT");
        expect((await admin.query("select to_regclass('sophia_voice_lab.recovery_controls') as name")).rows[0].name).toBeNull();
        expect(canonicalRequestHash(await readVoiceLabCatalog(admin))).toBe(oldCatalog);
        expect(await upgradeHistoricalRecovery(oldAdapter.pool, partitions, extension, oldCatalog, targetCatalog)).toMatchObject({ controlsBackfilled: 1, catalogSha256: targetCatalog });
        expect((await admin.query("select row_to_json(r) as row from sophia_voice_lab.runs r")).rows).toEqual(preservedRun);
        expect((await admin.query("select row_to_json(r) as row from sophia_voice_lab.browser_leases r")).rows).toEqual(preservedLease);
        expect((await admin.query("select row_to_json(r) as row from sophia_voice_lab.run_events r order by seq")).rows).toEqual(preservedEvents);
        expect(await oldAdapter.getRecoveryControl(historical.id)).toMatchObject({ browserAllocationEver: true, liveCleanupComplete: false, binding: { cleanupObligationId: historical.cleanupObligationId } });
        expect((await oldAdapter.getRecoveryControl(historical.id))?.browserAllocationBinding).toEqual(deriveRecoveryBrowserBinding(historical.id, "historical-lost-owner", 7));
        expect(await oldAdapter.countActiveRuns()).toBe(1);
        await oldAdapter.releaseBrowserLease(historical.id, "historical-lost-owner", 7);
        expect((await oldAdapter.getRecoveryControl(historical.id))?.browserAllocationBinding).toEqual(deriveRecoveryBrowserBinding(historical.id, "historical-lost-owner", 7));
        expect(await oldAdapter.countActiveRuns()).toBe(1);
        expect(await oldAdapter.countActiveRuns(historical.callerId)).toBe(1);
        expect((await oldAdapter.listRunsNeedingRecovery(10)).map((run) => run.id)).toContain(historical.id);
        expect(await oldAdapter.listRunsNeedingRecovery(10, historical.id)).toEqual([]);
        await expect(oldAdapter.listRunsNeedingRecovery(10, "invalid-cursor")).rejects.toThrow();
        await expect(oldAdapter.listRunsNeedingRecovery(0)).rejects.toThrow();
        const currentHistorical = (await oldAdapter.getRun(historical.id))!;
        await oldAdapter.updateRun(historical.id, currentHistorical.version, { traceId: "historical-trace-projection" });
        expect(await oldAdapter.getRecoveryControl(historical.id)).toMatchObject({ liveCleanupComplete: false });
        expect(await oldAdapter.countActiveRuns()).toBe(1);
        expect((await oldAdapter.listRunsNeedingRecovery(10)).map((run) => run.id)).toContain(historical.id);
        const blockedReplacement = testRun();
        await expect(oldAdapter.createRunWithOperation(blockedReplacement, { id: randomUUID(), runId: blockedReplacement.id, callerId: blockedReplacement.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(blockedReplacement.id), input: {} }, { global: 1, caller: 1 })).rejects.toMatchObject({ detail: { code: "CONCURRENCY_LIMIT" } });
      } finally { await oldAdapter.close(); }
      await admin.query("drop schema sophia_voice_lab cascade");
      await proveHistoricalQuarantine(admin, databaseUrl, runMigration);
    }
    finally { await admin.end(); }

    // Two actual migration processes contend on the compiled advisory lock.
    // Both must attest the same immutable migration and exact catalog.
    await Promise.all([runMigration(databaseUrl), runMigration(databaseUrl)]);
    ledger = new PostgresVoiceLabLedger(databaseUrl, 20, `retention-${namespace}-00000000000000000000000000000000`, { activeKeyId: "pg-v1", keys: { "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } });
    oauth = new PostgresOAuthLedgerStore(databaseUrl, 20, 86_400, { activeKeyId: "pg-v1", keys: { "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } }, "operator");
    await ledger.initialize();
    expect(await ledger.health()).toEqual({ ok: true, detail: "postgres-schema-attested" });
    expect(await oauth.readiness()).toBe(true);
  }, 90_000);

  afterAll(async () => {
    await oauth?.close().catch(() => undefined);
    await ledger?.close().catch(() => undefined);
    if (!databaseUrl) return;
    const admin = new Client({ connectionString: databaseUrl, application_name: "voice-lab-pg-test-cleanup" });
    await admin.connect();
    try { await admin.query("drop schema if exists sophia_voice_lab cascade"); }
    finally { await admin.end(); }
  }, 30_000);

  it("refuses to seal pre-existing column/index/ACL drift against the release reference", async () => {
    await ledger!.pool.query("alter table sophia_voice_lab.runs add column unexpected_drift text");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("alter table sophia_voice_lab.runs drop column unexpected_drift");

    await ledger!.pool.query("create index unexpected_drift_idx on sophia_voice_lab.runs (updated_at)");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("drop index sophia_voice_lab.unexpected_drift_idx");

    await ledger!.pool.query("grant select on sophia_voice_lab.runs to public");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("revoke all on sophia_voice_lab.runs from public");

    await ledger!.pool.query("grant select (id) on sophia_voice_lab.runs to public");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("revoke select (id) on sophia_voice_lab.runs from public");

    await ledger!.pool.query("create type sophia_voice_lab.unexpected_composite as (value text)");
    await expect(runMigration(databaseUrl)).rejects.toThrow();
    await ledger!.pool.query("drop type sophia_voice_lab.unexpected_composite");

    // The release contract seals object ownership as the runtime role and
    // normalizes every object ACL. A role which can still DML the table must
    // not green readiness after ownership/authority drift.
    const driftRole = `voice_lab_drift_${namespace.replace(/-/g, "").slice(0, 20)}`;
    const role = `"${driftRole}"`;
    const current = await ledger!.pool.query<{ role: string }>("select quote_ident(current_user) as role");
    await ledger!.pool.query(`create role ${role} nologin`);
    try {
      await ledger!.pool.query(`grant ${role} to ${current.rows[0]!.role}`);
      await ledger!.pool.query(`grant usage,create on schema sophia_voice_lab to ${role}`);
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${role}`);
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${current.rows[0]!.role}`);
      await ledger!.pool.query(`revoke all on schema sophia_voice_lab from ${role}`);
      await ledger!.pool.query(`grant select on sophia_voice_lab.runs to ${role}`);
      await expect(runMigration(databaseUrl)).rejects.toThrow();
      await ledger!.pool.query(`revoke all on sophia_voice_lab.runs from ${role}`);
    } finally {
      await ledger!.pool.query(`alter table sophia_voice_lab.runs owner to ${current.rows[0]!.role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke all on sophia_voice_lab.runs from ${role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke all on schema sophia_voice_lab from ${role}`).catch(() => undefined);
      await ledger!.pool.query(`revoke ${role} from ${current.rows[0]!.role}`).catch(() => undefined);
      await ledger!.pool.query(`drop role if exists ${role}`).catch(() => undefined);
    }
    await expect(runMigration(databaseUrl)).resolves.toBeUndefined();
  }, 300_000);

  it("bounds runtime pool acquisition, server statements and lock waits without losing connection usability", async () => {
    const bounded = new PostgresVoiceLabLedger(databaseUrl, 1);
    try {
      const settings = await bounded.pool.query("select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock");
      expect(settings.rows[0]).toEqual({ statement: '5s', lock: '2s' });
      let started = Date.now();
      await expect(bounded.pool.query("select pg_sleep(30)")).rejects.toMatchObject({ code: "57014" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(LEDGER_STATEMENT_TIMEOUT_MS - 100);
      expect(Date.now() - started).toBeLessThan(LEDGER_STATEMENT_TIMEOUT_MS + 5_000);
      expect((await bounded.pool.query("select 1 as healthy")).rows[0].healthy).toBe(1);

      const held = await bounded.pool.connect();
      try {
        started = Date.now();
        await expect(bounded.pool.connect()).rejects.toThrow(/timeout/i);
        expect(Date.now() - started).toBeGreaterThanOrEqual(LEDGER_CONNECT_TIMEOUT_MS - 100);
        expect(Date.now() - started).toBeLessThan(LEDGER_CONNECT_TIMEOUT_MS + 5_000);
      } finally { held.release(); }
      expect((await bounded.pool.query("select 1 as healthy")).rows[0].healthy).toBe(1);

      const blocker = await ledger!.pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("lock table sophia_voice_lab.browser_leases in access exclusive mode");
        started = Date.now();
        await expect(bounded.reapExpiredBrowserLeases(undefined, 10)).rejects.toMatchObject({ code: "55P03" });
        expect(Date.now() - started).toBeGreaterThanOrEqual(LEDGER_LOCK_TIMEOUT_MS - 100);
        expect(Date.now() - started).toBeLessThan(LEDGER_LOCK_TIMEOUT_MS + 5_000);
      } finally { await blocker.query("rollback"); blocker.release(); }
      await expect(bounded.reapExpiredBrowserLeases(undefined, 10)).resolves.toEqual([]);
    } finally { await bounded.close(); }
  }, 30_000);

  it("never reconstructs allocated execution after lease deletion", async () => {
    const { verifyBrowserAllocationOnce } = await import("./browser-allocation-once-helper.js");
    await verifyBrowserAllocationOnce(ledger!);
  });

  it("preserves exact execution cleanup independently of content retention", async () => {
    await verifyPreservedExecutionCleanup(ledger!);
  });

  it("atomically releases only an expired exact dead execution with preserved cleanup", async () => {
    await verifyRecoveredLeaseRelease(ledger!);
  });

  it("persists one-shot generic owner dispatch across concurrent consumption and purge", async () => {
    const { verifyGenericOwnerDispatch } = await import("./generic-owner-dispatch-helper.js");
    const ids: string[] = [];
    try { await verifyGenericOwnerDispatch(ledger!, ids); }
    finally {
      // Only synthetic ledger fixtures from this test; no provider calls exist.
      await ledger!.pool.query("delete from sophia_voice_lab.browser_leases where run_id=any($1::uuid[])", [ids]);
      await ledger!.pool.query("delete from sophia_voice_lab.runs where id=any($1::uuid[])", [ids]);
      await ledger!.pool.query("delete from sophia_voice_lab.recovery_controls where run_id=any($1::uuid[])", [ids]);
    }
  });

  it("rejects expired browser heartbeats before reaping without erasing recovery obligations", async () => {
    const run = testRun({ state: "completed", cleanupComplete: true });
    await ledger!.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    await ledger!.cancelPendingRunOperations(run.id, null, labError("TEST_FIXTURE_COMPLETE", "Ledger-only lease test does not dispatch a start.", "harness"));
    const lease = await ledger!.upsertBrowserLease(run.id, "expiry-owner", 60);
    expect((await ledger!.getRecoveryControl(run.id))?.browserAllocationEver).toBe(true);
    expect(await ledger!.heartbeatBrowserLease(run.id, "foreign", lease.leaseEpoch, 60)).toBe(false);
    expect(await ledger!.heartbeatBrowserLease(run.id, lease.workerId, lease.leaseEpoch, 60)).toBe(true);
    await ledger!.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '1 millisecond' where run_id=$1", [run.id]);
    const expired = await ledger!.getBrowserLease(run.id);
    expect(await ledger!.heartbeatBrowserLease(run.id, lease.workerId, lease.leaseEpoch, 60)).toBe(false);
    expect(await ledger!.getBrowserLease(run.id)).toEqual(expired);
    // Production default uses the database clock, not host/VM agreement.
    expect(await ledger!.reapExpiredBrowserLeases()).toEqual([expired]);
    expect(await ledger!.getBrowserLease(run.id)).toEqual(expired);
    expect(await ledger!.reapExpiredBrowserLeases()).toEqual([expired]);
    expect(await ledger!.reapExpiredBrowserLeases(undefined, 1)).toEqual([expired]);
    expect(await ledger!.reapExpiredBrowserLeases(undefined, 1, run.id)).toEqual([]);
    for (const limit of [0, -1, 101, 1.5, NaN]) await expect(ledger!.reapExpiredBrowserLeases(undefined, limit)).rejects.toThrow(RangeError);
    const replacement = new PostgresVoiceLabLedger(databaseUrl);
    try {
      expect(await replacement.getBrowserLease(run.id)).toEqual(expired);
      expect(await replacement.reapExpiredBrowserLeases()).toEqual([expired]);
    } finally { await replacement.close(); }
    expect(await ledger!.heartbeatBrowserLease(run.id, lease.workerId, lease.leaseEpoch, 60)).toBe(false);
    expect(await ledger!.getRecoveryControl(run.id)).not.toBeNull();
    expect((await ledger!.getRecoveryControl(run.id))?.browserAllocationEver).toBe(true);
    // Dispose this ledger-only fixture explicitly; expiry is no longer cleanup.
    expect(await ledger!.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
  });

  it("pages expired receipts on the database clock without losing any lease", async () => {
    const leases = [];
    for (let i = 0; i < 12; i++) {
      const run = testRun({ state: "completed", cleanupComplete: true });
      await ledger!.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 20, caller: 20 });
      await ledger!.cancelPendingRunOperations(run.id, null, labError("TEST_FIXTURE_COMPLETE", "Ledger-only paging fixture.", "harness"));
      leases.push(await ledger!.upsertBrowserLease(run.id, "paging-owner", 0));
    }
    try {
      const expected = [...leases].sort((a, b) => a.runId < b.runId ? -1 : 1);
      const first = await ledger!.reapExpiredBrowserLeases(undefined, 10);
      const second = await ledger!.reapExpiredBrowserLeases(undefined, 10, first.at(-1)!.runId);
      expect(first).toEqual(expected.slice(0, 10));
      expect(second).toEqual(expected.slice(10));
      expect(await ledger!.reapExpiredBrowserLeases(undefined, 10, second.at(-1)!.runId)).toEqual([]);
      const replacement = new PostgresVoiceLabLedger(databaseUrl);
      try {
        expect(await replacement.reapExpiredBrowserLeases(undefined, 10)).toEqual(first);
        for (const lease of leases) expect(await replacement.getBrowserLease(lease.runId)).toEqual(lease);
      } finally { await replacement.close(); }
    } finally {
      // Explicit disposal of ledger-only test fixtures, not expiry-based cleanup.
      for (const lease of leases) await ledger!.releaseBrowserLease(lease.runId, lease.workerId, lease.leaseEpoch);
    }
  });

  it("atomically binds D02 driver ownership to its lease and preserves it through purge", async () => {
    const run = testRun({ scenarioId: "V-D02", state: "failed_harness", cleanupComplete: true, retentionPurgeDueAt: new Date(0), retentionPurgeVerifiedAt: new Date() });
    await ledger!.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    const lease = await ledger!.upsertBrowserLease(run.id, "d02-control-worker", 60);
    const binding = deriveD02BrowserContextBinding(run, lease.workerId, lease.leaseEpoch);
    const foreign = deriveD02BrowserContextBinding(run, "foreign-worker", lease.leaseEpoch);
    expect((await ledger!.getRecoveryControl(run.id))?.browserAllocationBinding).toEqual(binding);
    await expect(ledger!.upsertBrowserLease(run.id, lease.workerId, 60)).rejects.toMatchObject({ detail: { code: "BROWSER_ALLOCATION_ALREADY_RESERVED" } });
    expect(await ledger!.getBrowserLease(run.id)).toEqual(lease);
    await expect(ledger!.bindRecoveryBrowserContext(run.id, "foreign-worker", lease.leaseEpoch, foreign)).rejects.toMatchObject({ detail: { code: "RECOVERY_BINDING_CONFLICT" } });
    expect((await ledger!.getRecoveryControl(run.id))?.browserContextBinding).toBeUndefined();
    const results = await Promise.all(Array.from({ length: 4 }, () => ledger!.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, binding)));
    expect(new Set(results.map(item => item.version)).size).toBe(1);
    await expect(ledger!.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, { ...binding, browser_context_id_sha256: "a".repeat(64) })).rejects.toThrow();
    await ledger!.purgeExpiredRetention(new Date(), 10);
    expect(await ledger!.getRun(run.id)).toBeNull();
    expect((await ledger!.getRecoveryControl(run.id))?.browserContextBinding).toEqual(binding);
    await expect(ledger!.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, binding)).rejects.toMatchObject({ detail: { code: "RECOVERY_BINDING_UNAVAILABLE" } });
    // Synthetic ledger-only allocation: no browser or provider was created.
    expect(await ledger!.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
    expect(await ledger!.countActiveRuns()).toBe(0);
  });

  it("preserves allocation and admission across content purge, then settles through the shared control API", async () => {
    const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(Date.now() - 1000), retentionPurgePending: true });
    const operation = { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start" as const, idempotencyKey: randomUUID(), requestHash: sha256("pg-retention-control"), input: {} };
    await ledger!.createRunWithOperation(run, operation, { global: 1, caller: 1 });
    const lease = await ledger!.upsertBrowserLease(run.id, "pg-owned-worker", 60);
    for (const event of completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch)) await ledger!.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey ?? undefined);
    await ledger!.preserveRecoveryExecutionCleanup(run.id);
    const bytes = Buffer.from(JSON.stringify({ synthetic: "EXPIRED_SYNTHETIC_CONTENT" }));
    const artifact = await ledger!.saveArtifact({ id: randomUUID(), runId: run.id, kind: "capture_json", contentType: "application/json", bytes, sha256: sha256(bytes), createdAt: new Date() });
    await ledger!.purgeExpiredRetention(new Date(), 10);
    expect(await ledger!.getRun(run.id)).toBeNull();
    expect(await ledger!.getArtifact(artifact.id)).toBeNull();
    expect(await ledger!.getBrowserLease(run.id)).toEqual(lease);
    expect(await ledger!.countActiveRuns()).toBe(1);
    expect(await ledger!.countActiveRuns(run.callerId)).toBe(1);
    const retained = (await ledger!.getRecoveryControl(run.id))!;
    expect(retained.binding.cleanupObligationId).toBe(run.cleanupObligationId);
    expect(JSON.stringify(retained)).not.toContain("EXPIRED_SYNTHETIC_CONTENT");
    const replacement = testRun();
    await expect(ledger!.createRunWithOperation(replacement, { ...operation, id: randomUUID(), runId: replacement.id, idempotencyKey: randomUUID() }, { global: 1, caller: 1 })).rejects.toMatchObject({ detail: { code: "CONCURRENCY_LIMIT" } });
    await expect(ledger!.upsertBrowserLease(run.id, "replacement", 60)).rejects.toMatchObject({ detail: { code: "RUN_NOT_FOUND" } });
    const proof = { kind: "cleanup.recovery", source: "canonical", payload: { complete: true, http_status: 200, retention_purged: true, receipt: {
      test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), complete: true, live_cleanup_complete: true, live_resources_zero: true,
      retention_purged: true, retention_purge_pending: false, retention_maintenance_complete: true,
      components: { canonical_session: { status: "completed" }, voice_provider: { status: "completed" }, auth_sessions: { status: "completed" }, builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } },
      receipt: { storage: "postgres", object_path: "synthetic/receipt", sha256: "a".repeat(64) },
    } } };
    await expect(ledger!.settleRecoveryControl(run.id, retained.version, proof)).rejects.toMatchObject({ detail: { code: "RECOVERY_BROWSER_UNSETTLED" } });
    expect(await ledger!.releaseBrowserLease(run.id, lease.workerId, lease.leaseEpoch)).toBe(true);
    await ledger!.settleRecoveryControl(run.id, retained.version, proof);
    expect(await ledger!.countActiveRuns()).toBe(0);
    expect(await ledger!.getRetentionTombstone(run.id, run.callerId)).toMatchObject({ remotePurgeStatus: "confirmed" });
  });

  it("atomically preserves the D02 dispatch journal across raw content purge", async () => {
    await verifyD02JournalDurability(ledger!, async (claim, runId) => {
      // Observe the journal inside the dispatch transaction, then fail the
      // subsequent INSERT. A pre-write guard failure alone cannot prove this.
      await ledger!.pool.query(`create function sophia_voice_lab.test_fail_d02_insert() returns trigger language plpgsql as $$
        begin
          if NEW.kind = 'product.d02_render_worker_dispatch_claimed' then
            if not exists (select 1 from sophia_voice_lab.recovery_controls where run_id = NEW.run_id and d02_journal is not null) then
              raise exception 'D02_JOURNAL_NOT_WRITTEN';
            end if;
            raise exception 'D02_POST_JOURNAL_INSERT_FAILURE';
          end if;
          return NEW;
        end $$`);
      try {
        await ledger!.pool.query(`create trigger test_fail_d02_insert before insert on sophia_voice_lab.run_events for each row execute function sophia_voice_lab.test_fail_d02_insert()`);
        await expect(claim()).rejects.toThrow('D02_POST_JOURNAL_INSERT_FAILURE');
        expect((await ledger!.pool.query('select count(*)::int as n from sophia_voice_lab.run_events where run_id=$1 and kind=$2', [runId, 'product.d02_render_worker_dispatch_claimed'])).rows[0].n).toBe(0);
      } finally {
        await ledger!.pool.query('drop trigger if exists test_fail_d02_insert on sophia_voice_lab.run_events');
        await ledger!.pool.query('drop function sophia_voice_lab.test_fail_d02_insert()');
      }
    });
  });

  it("keeps PostgreSQL usage accounting when aggregate provider spend is unlimited", async () => {
    const cap = { runStarts: 1000, providerSeconds: null, suites: 1000, suiteChildren: 1000, audioDurationMs: 1000000, audioBytes: 1000000 };
    const limits = { windowSeconds: 86400, global: cap, caller: cap };
    const reservation = { reservationKey: sha256(`unlimited-${namespace}`), requestHash: sha256("unlimited-request"), callerId: `unlimited-${namespace}`, environment: "staging" as const, kind: "run" as const, runStarts: 1, providerSeconds: 1000000, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt: new Date() };
    const result = await ledger!.reserveRollingAdmission(reservation, limits);
    expect(result.remaining.global.providerSeconds).toBeNull();
    expect(result.remaining.caller.providerSeconds).toBeNull();
    expect((await ledger!.reserveRollingAdmission(reservation, limits)).replay).toBe(true);
    await expect(ledger!.reserveRollingAdmission({ ...reservation, providerSeconds: 0 }, limits)).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });
    const next = { ...reservation, reservationKey: sha256(`next-unlimited-${namespace}`), requestHash: sha256("next-unlimited-request") };
    for (const side of ["global", "caller"] as const) {
      await expect(ledger!.reserveRollingAdmission(next, { ...limits, [side]: { ...cap, providerSeconds: 1000001 } })).rejects.toMatchObject({ detail: { code: "ROLLING_PROVIDER_SECONDS_LIMIT" } });
    }
    await expect(ledger!.reserveRollingAdmission(next, { ...limits, caller: { ...cap, runStarts: 1 } })).rejects.toMatchObject({ detail: { code: "ROLLING_RUN_STARTS_LIMIT" } });
  });

  it("atomically replays 20 starts, appends gap-free deduped events, and preserves immutable artifacts", async () => {
    const observedAt = new Date();
    const callerId = `pg-caller-${namespace}`;
    const requestHash = sha256(`request-${namespace}`);
    const idempotencyKey = `start-${namespace}`;
    const reservationKey = sha256(`reservation-${namespace}`);
    const rolling = {
      reservation: { reservationKey, requestHash, callerId, environment: "production" as const, kind: "run" as const, runStarts: 1, providerSeconds: 1_800, suites: 0, suiteChildren: 0, audioDurationMs: 0, audioBytes: 0, observedAt },
      limits: {
        windowSeconds: 86_400,
        global: { runStarts: 100, providerSeconds: 180_000, suites: 10, suiteChildren: 100, audioDurationMs: 1_000_000, audioBytes: 100_000_000 },
        caller: { runStarts: 100, providerSeconds: 180_000, suites: 10, suiteChildren: 100, audioDurationMs: 1_000_000, audioBytes: 100_000_000 },
      },
    };
    const candidates = Array.from({ length: 20 }, () => {
      const run = testRun({ callerId, createdAt: observedAt, updatedAt: observedAt });
      const operation = { id: randomUUID(), runId: run.id, callerId, type: "start" as const, idempotencyKey, requestHash, input: { environment: "production" } };
      return { run, operation };
  });

    const results = await Promise.all(candidates.map(({ run, operation }) => ledger!.createRunWithOperation(run, operation, { global: 1, caller: 1 }, rolling)));
    expect(new Set(results.map((result) => result.run.id))).toHaveLength(1);
    expect(new Set(results.map((result) => result.operation.id))).toHaveLength(1);
    expect(results.filter((result) => !result.replay)).toHaveLength(1);
    expect(results.filter((result) => result.rollingAdmission?.replay === false)).toHaveLength(1);

    const changedRun = testRun({ callerId });
    await expect(ledger!.createRunWithOperation(changedRun, { id: randomUUID(), runId: changedRun.id, callerId, type: "start", idempotencyKey, requestHash: sha256(`changed-${namespace}`), input: {} }, { global: 1, caller: 1 }, { ...rolling, reservation: { ...rolling.reservation, requestHash: sha256(`changed-${namespace}`) } })).rejects.toMatchObject({ detail: { code: "IDEMPOTENCY_CONFLICT" } });

    const runId = results[0]!.run.id;
    const duplicate = await Promise.all(Array.from({ length: 20 }, () => ledger!.appendEvent(runId, "pg.duplicate", "worker", { proof: "same" }, "pg-duplicate")));
    expect(new Set(duplicate.map((event) => event.seq))).toEqual(new Set([1]));
    await expect(ledger!.appendEvent(runId, "pg.duplicate", "worker", { proof: "different" }, "pg-duplicate")).rejects.toMatchObject({ detail: { code: "DEDUPE_CONFLICT" } });
    await Promise.all(Array.from({ length: 40 }, (_, index) => ledger!.appendEvent(runId, "pg.unique", "worker", { index }, `pg-unique-${index}`)));
    const page = await ledger!.listEvents(runId, 0, 100);
    expect(page.events.map((event) => event.seq)).toEqual(Array.from({ length: 41 }, (_, index) => index + 1));

    const bytes = Buffer.from(`immutable-${namespace}`, "utf8");
    const artifactId = randomUUID();
    const artifact = { id: artifactId, runId, kind: "capture_json" as const, contentType: "application/json" as const, sha256: sha256(bytes), bytes, createdAt: new Date() };
    const persisted = await Promise.all(Array.from({ length: 20 }, () => ledger!.saveArtifact(artifact)));
    expect(new Set(persisted.map((row) => row.id))).toEqual(new Set([artifactId]));
    const changedBytes = Buffer.from(`changed-${namespace}`, "utf8");
    await expect(ledger!.saveArtifact({ ...artifact, sha256: sha256(changedBytes), bytes: changedBytes })).rejects.toMatchObject({ detail: { code: "ARTIFACT_ID_CONFLICT" } });

    await ledger!.recordAuthAudit({ runId: null, callerId, action: "mcp.body", argumentHash: sha256(`global-audit-${namespace}`), outcome: "denied", detail: {}, observedAt });
    const rotated = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-rotated-${namespace}-0000000000000000`, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000`, "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } });
    const retiredTooEarly = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-retired-${namespace}-0000000000000000`, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000` } });
    try {
      await expect(rotated.initialize()).resolves.toBeUndefined();
      await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: "CALLER_PARTITION_KEY_RETIRED_LIVE" } });
      await ledger!.pool.query("delete from sophia_voice_lab.admission_reservations where caller_partition_id like 'cp1:pg-v1:%'");
      await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: "CALLER_PARTITION_KEY_RETIRED_LIVE" } });
      await ledger!.pool.query("delete from sophia_voice_lab.auth_audit where run_id is null and caller_partition_id like 'cp1:pg-v1:%'");
      // Recovery controls still bind this key independently of retained audits.
      await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: "CALLER_PARTITION_KEY_RETIRED_LIVE" } });
    } finally {
      await rotated.close();
      await retiredTooEarly.close();
      // This ledger-only reservation never allocated a browser/provider. Retire
      // exactly its pending operation and run before the next real admission.
      await ledger!.cancelPendingRunOperations(runId, null, labError("TEST_FIXTURE_COMPLETE", "Ledger-only fixture completed without product allocation.", "harness"));
      const fixtureRun = (await ledger!.getRun(runId))!;
      await ledger!.updateRun(runId, fixtureRun.version, { state: "cancelled", cleanupComplete: true });
      expect(await ledger!.countActiveRuns()).toBe(0);
    }
  }, 180_000);

  it("collects real P01 MCP envelopes/audits and attaches the signed claim to the same PostgreSQL run", async () => {
    const result = await proveP01LiveBoundary(ledger!);
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollingCallCount).toBe(4);
  }, 60_000);

  it("retains bounded startup timeouts through the PostgreSQL P01 collector and verifier", async () => {
    const result = await proveP01LiveBoundary(ledger!, { delayedStart: true, delayedAssistant: true, delayedEvidence: true });
    expect(result.pollingCallCount).toBe(8);
  }, 60_000);

  it("serializes refresh replay/rotation/revocation by family and rolls back a mid-family failure", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const firstFamily = `family-race-${namespace}`;
    const r0 = refresh("r0", firstFamily, null, now);
    const a0 = access("a0", firstFamily, now);
    const r1 = refresh("r1", firstFamily, r0.tokenHash, now + 1);
    const a1 = access("a1", firstFamily, now + 1);
    await putInitialPair("r0", r0, a0, now);
    expect((await oauth!.rotateRefreshToken(r0.tokenHash, r0.jti, r1, a1, now + 1)).status).toBe("rotated");
    const r2 = refresh("r2", firstFamily, r1.tokenHash, now + 2);
    const a2 = access("a2", firstFamily, now + 2);
    const replayReplacement = refresh("replay", firstFamily, r0.tokenHash, now + 2);
    const replayAccess = access("replay", firstFamily, now + 2);
    const race = await Promise.all([
      oauth!.rotateRefreshToken(r0.tokenHash, r0.jti, replayReplacement, replayAccess, now + 2),
      oauth!.rotateRefreshToken(r1.tokenHash, r1.jti, r2, a2, now + 2),
    ]);
    expect(race.some((result) => result.status === "replayed")).toBe(true);
    expect(await liveFamilyRows(firstFamily)).toEqual({ access: 0, refresh: 0 });

    const revokeFamily = `family-revoke-${namespace}`;
    const q0 = refresh("q0", revokeFamily, null, now);
    const qa0 = access("qa0", revokeFamily, now);
    await putInitialPair("q0", q0, qa0, now);
    const q1 = refresh("q1", revokeFamily, q0.tokenHash, now + 1);
    const qa1 = access("qa1", revokeFamily, now + 1);
    await Promise.all([oauth!.revokeTokenFamily(revokeFamily, now + 1), oauth!.rotateRefreshToken(q0.tokenHash, q0.jti, q1, qa1, now + 1)]);
    expect(await liveFamilyRows(revokeFamily)).toEqual({ access: 0, refresh: 0 });

    const rollbackFamily = `family-rollback-${namespace}`;
    const x0 = refresh("x0", rollbackFamily, null, now);
    const xa0 = access("xa0", rollbackFamily, now);
    await putInitialPair("x0", x0, xa0, now);
    await ledger!.pool.query(`create function sophia_voice_lab.test_fail_refresh_revoke() returns trigger language plpgsql as $$ begin if new.family_id='${rollbackFamily}' then raise exception 'injected family rollback'; end if; return new; end $$`);
    await ledger!.pool.query("create trigger test_fail_refresh_revoke before update on sophia_voice_lab.oauth_refresh_tokens for each row execute function sophia_voice_lab.test_fail_refresh_revoke()");
    try {
      await expect(oauth!.revokeTokenFamily(rollbackFamily, now + 1)).rejects.toThrow("injected family rollback");
      expect(await liveFamilyRows(rollbackFamily)).toEqual({ access: 1, refresh: 1 });
    } finally {
      await ledger!.pool.query("drop trigger if exists test_fail_refresh_revoke on sophia_voice_lab.oauth_refresh_tokens");
      await ledger!.pool.query("drop function if exists sophia_voice_lab.test_fail_refresh_revoke()");
    }
  }, 60_000);

  it("stores no raw OAuth subject and blocks subject-partition key retirement until live grants expire", async () => {
    const now = Math.floor(Date.now() / 1_000);
    const request: OAuthAuthorizationRequestRecord = {
      requestHash: sha256(`${namespace}:oauth-request-partition`),
      csrfHash: sha256(`${namespace}:oauth-csrf-partition`),
      clientId: "https://chatgpt.com/oauth/client.json",
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource: "https://voice-lab.test/mcp",
      state: "state-partition-test",
      scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"],
      codeChallenge: "A".repeat(43),
      subject: "operator",
      issuedAt: now,
      expiresAt: now + 300,
      consumedAt: null,
    };
    await oauth!.putAuthorizationRequest(request);
    expect((await oauth!.consumeAuthorizationRequest(request.requestHash, request.csrfHash, now + 1))?.subject).toBe("operator");
    const durable = await ledger!.pool.query<{ subject: string }>(
      `select subject from sophia_voice_lab.oauth_authorization_requests
       union all select subject from sophia_voice_lab.oauth_authorization_codes
       union all select subject from sophia_voice_lab.oauth_access_tokens
       union all select subject from sophia_voice_lab.oauth_refresh_tokens`,
    );
    expect(durable.rows.length).toBeGreaterThan(0);
    expect(durable.rows.every((row) => /^cp1:pg-v1:[a-f0-9]{64}$/.test(row.subject))).toBe(true);
    expect(JSON.stringify(durable.rows)).not.toContain("operator");

    const rotated = new PostgresOAuthLedgerStore(databaseUrl, 2, 86_400, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000`, "pg-v1": `caller-partition-${namespace}-000000000000000000000000` } }, "operator");
    const retiredTooEarly = new PostgresOAuthLedgerStore(databaseUrl, 2, 86_400, { activeKeyId: "pg-v2", keys: { "pg-v2": `caller-partition-v2-${namespace}-00000000000000000000` } }, "operator");
    try {
      expect(await rotated.readiness()).toBe(true);
      expect(await retiredTooEarly.readiness()).toBe(false);
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_access_tokens");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_refresh_tokens");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_authorization_codes");
      await ledger!.pool.query("delete from sophia_voice_lab.oauth_authorization_requests");
      expect(await retiredTooEarly.readiness()).toBe(true);
    } finally {
      await rotated.close();
      await retiredTooEarly.close();
    }
  }, 60_000);

  it("atomically claims the singleton and rolls back completion when its auth audit insert fails", async () => {
    const now = new Date();
    const callerId = "system.principal-provision-operator";
    const preparation = {
      requestHash: sha256(`${namespace}:principal-request`),
      idempotencyKeyHash: sha256(`${namespace}:principal-idempotency`),
      principalHash: sha256(`${namespace}:principal`),
      callerId,
      issuedAt: now,
      testRunId: randomUUID(),
      cleanupObligationId: randomUUID(),
      capabilityJti: "1".repeat(32),
      capabilityNonce: "2".repeat(32),
      capabilityHash: "3".repeat(64),
      providerExpiresAt: new Date(now.getTime() + 600_000),
      environment: "production" as const,
      expectedDeployment: { frontend: "a".repeat(40), backend: "b".repeat(40), voice: "c".repeat(40) },
      mcpBuild: "d".repeat(40),
      operatorSubjectHash: sha256(callerId),
    };
    const owners = Array.from({ length: 10 }, () => randomUUID());
    const claims = await Promise.all(owners.map((owner) => ledger!.claimPrincipalProvision(preparation, owner, 30, now)));
    expect(claims.filter((claim) => claim.disposition === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.disposition === "pending")).toHaveLength(9);
    const claimed = claims.find((claim) => claim.disposition === "claimed")!;
    const owner = owners[claims.indexOf(claimed)]!;
    const receiptCore = {
      schema: 'sophia_voice_lab_principal_provision_receipt_v1',
      ok: true,
      provisioned: true,
      idempotency_key_sha256: preparation.idempotencyKeyHash,
      operator_request_sha256: preparation.requestHash,
      principal_id_sha256: preparation.principalHash,
      capability_sha256: preparation.capabilityHash,
      capability_jti_sha256: sha256(preparation.capabilityJti),
      test_run_id_sha256: sha256(preparation.testRunId),
      cleanup_obligation_id_sha256: sha256(preparation.cleanupObligationId),
      environment: preparation.environment,
      frontend_build: preparation.expectedDeployment.frontend,
      mcp_build: preparation.mcpBuild,
      expected_deployment: preparation.expectedDeployment,
      frontend_attempts: 1,
      frontend_reconciled: false,
      auth_audit_id: claimed.record.authAuditId,
      audit_observed_at: claimed.record.auditObservedAt.toISOString(),
      operator_subject_sha256: preparation.operatorSubjectHash,
    } as const;
    const receipt = { ...receiptCore, idempotent_replay: false, receipt_sha256: canonicalRequestHash(receiptCore) };
    const audit = {
      id: claimed.record.authAuditId,
      runId: null,
      callerId,
      action: "principal.provision",
      capabilityJtiHash: sha256(preparation.capabilityJti),
      argumentHash: preparation.requestHash,
      outcome: "allowed" as const,
      detail: receipt,
      observedAt: claimed.record.auditObservedAt,
    };
    const rotatedLedger = new PostgresVoiceLabLedger(databaseUrl, 4, `retention-${namespace}-00000000000000000000000000000000`, {
      activeKeyId: 'pg-v2',
      keys: {
        'pg-v2': `caller-partition-rotated-${namespace}-000000000000000000000000`,
        'pg-v1': `caller-partition-${namespace}-000000000000000000000000`,
      },
    });
    await rotatedLedger.initialize();
    await ledger!.pool.query("create function sophia_voice_lab.test_fail_principal_audit() returns trigger language plpgsql as $$ begin if new.action='principal.provision' then raise exception 'injected principal audit rollback'; end if; return new; end $$");
    await ledger!.pool.query("create trigger test_fail_principal_audit before insert on sophia_voice_lab.auth_audit for each row execute function sophia_voice_lab.test_fail_principal_audit()");
    try {
      await expect(rotatedLedger.finalizePrincipalProvision(preparation.requestHash, owner, receipt, audit, new Date())).rejects.toThrow("injected principal audit rollback");
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "prepared" });
    } finally {
      await ledger!.pool.query("drop trigger if exists test_fail_principal_audit on sophia_voice_lab.auth_audit");
      await ledger!.pool.query("drop function if exists sophia_voice_lab.test_fail_principal_audit()");
    }
    await rotatedLedger.finalizePrincipalProvision(preparation.requestHash, owner, receipt, audit, new Date());
    await rotatedLedger.close();
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "completed" });
    const retiredTooEarly = new PostgresVoiceLabLedger(databaseUrl, 2, `retention-${namespace}-00000000000000000000000000000000`, {
      activeKeyId: 'pg-v2',
      keys: { 'pg-v2': `caller-partition-rotated-${namespace}-000000000000000000000000` },
    });
    await expect(retiredTooEarly.initialize()).rejects.toMatchObject({ detail: { code: 'CALLER_PARTITION_KEY_RETIRED_LIVE' } });
    await retiredTooEarly.close();
    const receiptDrifts: Array<(value: Record<string, any>) => void> = [
      (value) => { value.schema = 'foreign'; },
      (value) => { value.idempotency_key_sha256 = '0'.repeat(64); },
      (value) => { value.operator_request_sha256 = '0'.repeat(64); },
      (value) => { value.principal_id_sha256 = '0'.repeat(64); },
      (value) => { value.capability_sha256 = '0'.repeat(64); },
      (value) => { value.capability_jti_sha256 = '0'.repeat(64); },
      (value) => { value.test_run_id_sha256 = '0'.repeat(64); },
      (value) => { value.cleanup_obligation_id_sha256 = '0'.repeat(64); },
      (value) => { value.environment = 'staging'; },
      (value) => { value.frontend_build = 'e'.repeat(40); },
      (value) => { value.mcp_build = 'e'.repeat(40); },
      (value) => { value.expected_deployment.frontend = 'e'.repeat(40); },
      (value) => { value.frontend_attempts = 0; value.frontend_reconciled = false; },
      (value) => { value.auth_audit_id = String(Number(value.auth_audit_id) + 1); },
      (value) => { value.audit_observed_at = '2026-08-24T12:00:00.000Z'; },
      (value) => { value.operator_subject_sha256 = '0'.repeat(64); },
    ];
    for (const mutate of receiptDrifts) {
      const drifted = structuredClone(receipt) as Record<string, any>;
      mutate(drifted);
      const { idempotent_replay: _replay, receipt_sha256: _digest, ...driftedCore } = drifted;
      drifted.idempotent_replay = false;
      drifted.receipt_sha256 = canonicalRequestHash(driftedCore);
      await ledger!.pool.query('update sophia_voice_lab.principal_provisions set receipt=$2 where request_hash=$1', [preparation.requestHash, drifted]);
      await ledger!.pool.query('update sophia_voice_lab.auth_audit set detail=$2 where id=$1', [claimed.record.authAuditId, drifted]);
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'invalid' });
      await ledger!.pool.query('update sophia_voice_lab.principal_provisions set receipt=$2 where request_hash=$1', [preparation.requestHash, receipt]);
      await ledger!.pool.query('update sophia_voice_lab.auth_audit set detail=$2 where id=$1', [claimed.record.authAuditId, receipt]);
      expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: 'completed' });
    }
    await ledger!.pool.query("update sophia_voice_lab.auth_audit set capability_jti_hash=$2 where id=$1", [claimed.record.authAuditId, "0".repeat(64)]);
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "invalid" });
    await ledger!.pool.query("update sophia_voice_lab.auth_audit set capability_jti_hash=$2 where id=$1", [claimed.record.authAuditId, audit.capabilityJtiHash]);
    expect(await ledger!.getPrincipalProvisionReadiness(new Date())).toEqual({ status: "completed" });
    const conflict = await ledger!.claimPrincipalProvision({ ...preparation, requestHash: sha256(`${namespace}:different-request`) }, randomUUID(), 30, new Date());
    expect(conflict.disposition).toBe("conflict");
    const stored = await ledger!.pool.query("select * from sophia_voice_lab.principal_provisions");
    expect(JSON.stringify(stored.rows)).not.toContain(callerId);
    expect(JSON.stringify(stored.rows)).not.toContain(`${namespace}:principal`);
  }, 60_000);
});

function assertDedicatedTestDatabase(raw: string): void {
  const parsed = new URL(raw);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!/(?:^|[_-])voice[_-]lab[_-]test(?:$|[_-])/i.test(database) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") {
    throw new Error("Postgres integration requires a dedicated *voice_lab_test* database and SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED=YES.");
  }
}

async function runMigration(url: string): Promise<void> {
  const cli = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const source = path.resolve(process.cwd(), "src/bin/migrate.ts");
  await execFileAsync(process.execPath, [cli, source], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url }, timeout: 60_000, maxBuffer: 1_000_000 });
}

function refresh(label: string, familyId: string, parentTokenHash: string | null, issuedAt: number): OAuthRefreshTokenRecord {
  return { tokenHash: sha256(`${namespace}:refresh:${label}`), issuer: "https://issuer.test", subject: "operator", clientId: "https://chatgpt.com/oauth/client.json", audience: "https://voice-lab.test/mcp", resource: "https://voice-lab.test/mcp", scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"], familyId, parentTokenHash, replacementTokenHash: null, jti: `jti-refresh-${label}-${namespace}`, issuedAt, expiresAt: issuedAt + 3_600, usedAt: null, revokedAt: null };
}

function access(label: string, familyId: string, issuedAt: number): OAuthAccessTokenRecord {
  return { tokenHash: sha256(`${namespace}:access:${label}`), issuer: "https://issuer.test", subject: "operator", clientId: "https://chatgpt.com/oauth/client.json", audience: "https://voice-lab.test/mcp", resource: "https://voice-lab.test/mcp", scopes: ["voice_lab:read", "voice_lab:run", "voice_lab:fault"], familyId, jti: `jti-access-${label}-${namespace}`, issuedAt, notBefore: issuedAt, expiresAt: issuedAt + 600, revokedAt: null };
}

async function putInitialPair(label: string, refreshRecord: OAuthRefreshTokenRecord, accessRecord: OAuthAccessTokenRecord, now: number): Promise<string> {
  const codeHash = sha256(`${namespace}:authorization-code:${label}`);
  const code: OAuthAuthorizationCodeRecord = {
    codeHash,
    clientId: refreshRecord.clientId,
    redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource: refreshRecord.resource,
    scopes: [...refreshRecord.scopes],
    codeChallenge: "A".repeat(43),
    subject: refreshRecord.subject,
    jti: `jti-code-${label}-${namespace}`,
    familyId: null,
    issuedAt: now - 1,
    expiresAt: now + 300,
    consumedAt: null,
    revokedAt: null,
  };
  await oauth!.putAuthorizationCode(code);
  expect(await oauth!.consumeAuthorizationCode(codeHash, now)).not.toBeNull();
  await oauth!.putInitialTokenPair(codeHash, refreshRecord, accessRecord);
  return codeHash;
}

async function liveFamilyRows(familyId: string): Promise<{ access: number; refresh: number }> {
  const result = await ledger!.pool.query<{ access: string; refresh: string }>(
    `select (select count(*) from sophia_voice_lab.oauth_access_tokens where family_id=$1 and revoked_at is null)::text as access,
            (select count(*) from sophia_voice_lab.oauth_refresh_tokens where family_id=$1 and revoked_at is null)::text as refresh`,
    [familyId],
  );
  return { access: Number(result.rows[0]!.access), refresh: Number(result.rows[0]!.refresh) };
}
