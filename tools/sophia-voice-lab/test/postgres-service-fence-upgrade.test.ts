import { readFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeVoiceLabMigration } from "../src/migration-bundle.js";
import { SERVICE_FENCE_SOURCE_BUNDLE_SHA256, SERVICE_FENCE_BUNDLE_SHA256 } from "../src/service-fence-migration.js";
import { serviceFenceInventory, upgradeServiceFenceSchema } from "../src/service-fence-upgrade.js";
import { readVoiceLabCatalog } from "../src/schema-attestation.js";
import { canonicalRequestHash } from "../src/security.js";
import { projectRecoveryControlBinding } from "../src/recovery-control.js";
import { testRun } from "./helpers.js";
import { serviceOwnerFenceFixture } from "./service-owner-fence-fixture.js";
import { PostgresRecoveryControls } from "../src/postgres-recovery-control.js";
import { combinedRecoveryFixture } from "./retained-d02-recovery-helper.js";
import { recoveryAttemptAuditHash } from "../src/retained-d02-recovery.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { verifyServiceFenceHttp } from "./service-fence-http-helper.js";

const url = process.env.SOPHIA_VOICE_LAB_FENCE_TEST_DATABASE_URL ?? "";
const suite = url ? describe : describe.skip;
suite("real PostgreSQL service-fence schema upgrade", () => {
  let pool: pg.Pool;
  let base: Buffer, recovery: Buffer, fence: Buffer;
  let sealDirectory: string;
  const execute = promisify(execFile);
  const migrate = () => execute(process.execPath, ["--import", "tsx", "src/bin/migrate.ts"], {
    env: { ...process.env, DATABASE_URL: url, TMPDIR: sealDirectory }, timeout: 30_000,
  });
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_c4_control_fence[a-z0-9_]*$/.test(parsed.pathname) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated disposable fence database required");
    pool = new pg.Pool({ connectionString: url, max: 2 });
    sealDirectory = await mkdtemp(path.join(tmpdir(), "voice-lab-fence-seal-"));
    expect((await pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    base = await readFile(new URL("../../../backend/migrations/2026_08_23_sophia_voice_lab.sql", import.meta.url));
    recovery = await readFile(new URL("../migrations/004_recovery_controls.sql", import.meta.url));
    fence = await readFile(new URL("../migrations/005_service_owner_fence.sql", import.meta.url));
    await pool.query("drop schema if exists sophia_voice_lab cascade");
    await pool.query(composeVoiceLabMigration(base, recovery).toString("utf8"));
    const catalog = canonicalRequestHash(await readVoiceLabCatalog(pool));
    await pool.query("update sophia_voice_lab.schema_metadata set schema_version=4,migration_sha256=$1,catalog_sha256=$2 where singleton=true", [SERVICE_FENCE_SOURCE_BUNDLE_SHA256, catalog]);
  });
  afterAll(async () => {
    try {
      if (pool) {
        try { await pool.query("drop schema if exists sophia_voice_lab cascade"); }
        finally { await pool.end(); }
      }
    } finally { if (sealDirectory) await rm(sealDirectory, { recursive: true, force: true }); }
  });

  it("rejects inventory drift, upgrades atomically, retains unresolved controls and recognizes replay", async () => {
    const run = testRun();
    const binding = projectRecoveryControlBinding(run, `cp1:test:${"a".repeat(64)}`);
    await pool.query(`insert into sophia_voice_lab.recovery_controls
      (run_id,test_run_id,cleanup_obligation_id,binding,version,live_cleanup_complete,remote_purge_complete,content_purged_at)
      values ($1,$2,$3,$4,1,false,false,now())`, [run.id, run.testRunId, run.cleanupObligationId, binding]);
    const before = (await pool.query("select row_to_json(t) as value from sophia_voice_lab.recovery_controls t")).rows;
    const client = await pool.connect();
    let inventory: string;
    try { inventory = await serviceFenceInventory(client); } finally { client.release(); }
    const intent = { commit: "f".repeat(40), inventorySha256: inventory };
    const diagnostic = await execute(process.execPath, ["--import", "tsx", "src/bin/service-fence-inventory.ts"], {
      env: { ...process.env, DATABASE_URL: url, COMMIT_SHA: intent.commit, RENDER_GIT_COMMIT: intent.commit,
        SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT: intent.commit }, timeout: 30_000,
    });
    expect(diagnostic.stderr).toBe("");
    expect(JSON.parse(diagnostic.stdout)).toMatchObject({ schemaVersion: 4, inventorySha256: inventory,
      catalogMatchesMetadata: true, upgradeAuthorized: false, cleanupProven: false, releaseCommit: intent.commit });
    expect(diagnostic.stdout).not.toContain(run.id);
    expect((await pool.query("select row_to_json(t) as value from sophia_voice_lab.recovery_controls t")).rows).toEqual(before);
    await expect(migrate()).rejects.toThrow(/pre-existing schema drift/);
    await pool.query("insert into sophia_voice_lab.worker_heartbeats (worker_id,service_version,browser_ready) values ('fence-test-worker','test',false)");
    await expect(upgradeServiceFenceSchema(pool, intent, base, recovery, fence)).rejects.toThrow(/NOT_QUIESCENT/);
    expect((await pool.query("select schema_version from sophia_voice_lab.schema_metadata")).rows[0].schema_version).toBe(4);
    await pool.query("delete from sophia_voice_lab.worker_heartbeats where worker_id='fence-test-worker'");
    await pool.query("alter table sophia_voice_lab.recovery_controls add column fence_test_drift boolean");
    await expect(upgradeServiceFenceSchema(pool, intent, base, recovery, fence)).rejects.toThrow(/CATALOG_DRIFT/);
    expect((await pool.query("select schema_version from sophia_voice_lab.schema_metadata")).rows[0].schema_version).toBe(4);
    await pool.query("alter table sophia_voice_lab.recovery_controls drop column fence_test_drift");
    await expect(upgradeServiceFenceSchema(pool, { ...intent, inventorySha256: "0".repeat(64) }, base, recovery, fence)).rejects.toThrow(/INVENTORY_DRIFT/);
    expect((await pool.query("select schema_version from sophia_voice_lab.schema_metadata")).rows[0].schema_version).toBe(4);
    const result = await upgradeServiceFenceSchema(pool, intent, base, recovery, fence);
    expect(result).toMatchObject({ replay: false, retainedObligationsChanged: false, admissionAuthorized: false, inventorySha256: inventory });
    expect((await pool.query("select row_to_json(t) as value from sophia_voice_lab.recovery_controls t")).rows).toEqual(before);
    expect((await pool.query("select schema_version,migration_sha256 from sophia_voice_lab.schema_metadata")).rows[0]).toEqual({ schema_version: 5, migration_sha256: SERVICE_FENCE_BUNDLE_SHA256 });
    expect(canonicalRequestHash(await readVoiceLabCatalog(pool))).toBe(result.catalogSha256);
    expect(await upgradeServiceFenceSchema(pool, intent, base, recovery, fence)).toEqual({ ...result, replay: true });
    const replay = await execute(process.execPath, ["--import", "tsx", "src/bin/upgrade-service-fence.ts"], {
      env: { ...process.env, DATABASE_URL: url, COMMIT_SHA: intent.commit, RENDER_GIT_COMMIT: intent.commit,
        SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_APPROVED: "YES", SOPHIA_VOICE_LAB_KILL_SWITCH: "true",
        SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_EXPECTED_COMMIT: intent.commit,
        SOPHIA_VOICE_LAB_SERVICE_FENCE_UPGRADE_INVENTORY_SHA256: inventory }, timeout: 30_000,
    });
    expect(replay.stderr).toBe("");
    expect(JSON.parse(replay.stdout)).toEqual({ ...result, replay: true });
    await migrate();
    expect(JSON.parse(await readFile(path.join(sealDirectory, "sophia-voice-lab-schema-v5.attestation.json"), "utf8")))
      .toEqual({ schema_version: 5, migration_sha256: SERVICE_FENCE_BUNDLE_SHA256, catalog_sha256: result.catalogSha256 });
    expect((await pool.query("select live_cleanup_complete,remote_purge_complete from sophia_voice_lab.recovery_controls")).rows[0]).toEqual({ live_cleanup_complete: false, remote_purge_complete: false });
  }, 30000);
  it("creates and seals a fresh v5 schema through the actual startup executable", async () => {
    await pool.query("drop schema sophia_voice_lab cascade");
    await migrate();
    const metadata = (await pool.query("select schema_version,migration_sha256,catalog_sha256 from sophia_voice_lab.schema_metadata")).rows[0];
    expect(metadata).toEqual({ schema_version: 5, migration_sha256: SERVICE_FENCE_BUNDLE_SHA256,
      catalog_sha256: canonicalRequestHash(await readVoiceLabCatalog(pool)) });
    await migrate();
  }, 30000);
  it("durably ingests the new proof after content purge without declaring cleanup, and rejects changed receipts", async () => {
    const f = serviceOwnerFenceFixture(new Date(Date.now() - 370000));
    const c = f.input.control;
    await pool.query(`insert into sophia_voice_lab.recovery_controls
      (run_id,test_run_id,cleanup_obligation_id,binding,version,browser_allocation_ever,browser_allocation_binding,
       generic_owner_dispatch,live_cleanup_complete,remote_purge_complete,content_purged_at)
      values ($1,$2,$3,$4,$5,true,$6,$7,false,false,$8)`,
      [c.binding.runId,c.binding.testRunId,c.binding.cleanupObligationId,c.binding,c.version,
        c.browserAllocationBinding,c.genericOwnerDispatch,c.contentPurgedAt]);
    const { control, acceptedAt, ...verification } = f.input;
    const input = { ...verification, runId: c.binding.runId, expectedVersion: c.version };
    const controls = new PostgresRecoveryControls(pool);
    await pool.query(`create function sophia_voice_lab.fence_test_abort() returns trigger language plpgsql as $$
      begin raise exception 'FENCE_POST_WRITE_FAILURE'; end $$`);
    await pool.query("create trigger fence_test_abort after update of generic_owner_loss on sophia_voice_lab.recovery_controls for each row execute function sophia_voice_lab.fence_test_abort()");
    try { await expect(controls.persistGenericOwnerLoss(input)).rejects.toThrow("FENCE_POST_WRITE_FAILURE"); }
    finally {
      await pool.query("drop trigger fence_test_abort on sophia_voice_lab.recovery_controls");
      await pool.query("drop function sophia_voice_lab.fence_test_abort()");
    }
    expect((await controls.get(c.binding.runId))!.genericOwnerLoss).toBeUndefined();
    expect((await controls.get(c.binding.runId))!.version).toBe(c.version);
    const result = await controls.persistGenericOwnerLoss(input);
    expect(result).toMatchObject({ replay: false, version: c.version + 1,
      proof: { schema: "sophia.voice-lab.verified-service-owner-fence.v1", providerCleanupProven: false, liveResourcesZeroProven: false } });
    const stored = (await pool.query("select generic_owner_loss,live_cleanup_complete,remote_purge_complete from sophia_voice_lab.recovery_controls where run_id=$1", [c.binding.runId])).rows[0];
    expect(stored).toEqual({ generic_owner_loss: result.proof, live_cleanup_complete: false, remote_purge_complete: false });
    expect(JSON.stringify(stored)).not.toContain(f.unsigned.allocatedWorkerId);
    const freshPool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const fresh = new PostgresRecoveryControls(freshPool);
      expect(await fresh.persistGenericOwnerLoss(input)).toEqual({ ...result, replay: true });
      await expect(fresh.persistGenericOwnerLoss({ ...input, receipt: f.signed({ ...f.unsigned,
        actionAcceptedResponseSha256: "f".repeat(64) }) })).rejects.toThrow(/IMMUTABLE/);
      expect(await fresh.persistGenericOwnerLoss(input)).toEqual({ ...result, replay: true });
    } finally { await freshPool.end(); }
    expect((await pool.query("select count(*)::int as count from sophia_voice_lab.runs where id=$1", [c.binding.runId])).rows[0].count).toBe(0);
    const retained = (await controls.get(c.binding.runId))!;
    const { event, attempt } = combinedRecoveryFixture(retained, Math.ceil(Date.now() / 1000));
    await pool.query("insert into sophia_voice_lab.browser_leases (run_id,worker_id,lease_epoch,expires_at,updated_at) values ($1,$2,1,now(),now())", [c.binding.runId,f.unsigned.allocatedWorkerId]);
    await expect(controls.settle(c.binding.runId, retained.version, event, attempt)).rejects.toMatchObject({ detail: { code: "RECOVERY_ATTEMPT_AUDIT_MISSING" } });
    await controls.recordCapabilityAudit(c.binding.runId, retained.version, "a".repeat(64), recoveryAttemptAuditHash(retained, attempt));
    for (const component of ["canonical_session", "voice_provider", "auth_sessions", "builder"] as const) {
      const incomplete = structuredClone(event);
      incomplete.payload.receipt.components[component].status = "pending";
      await expect(controls.settle(c.binding.runId, retained.version, incomplete, attempt)).rejects.toThrow();
    }
    const noBuilderZero = structuredClone(event);
    noBuilderZero.payload.receipt.components.builder.authoritative_zero_tasks = false;
    await expect(controls.settle(c.binding.runId, retained.version, noBuilderZero, attempt)).rejects.toThrow();
    await pool.query("update sophia_voice_lab.browser_leases set worker_id='foreign-owner' where run_id=$1", [c.binding.runId]);
    await expect(controls.settle(c.binding.runId, retained.version, event, attempt)).rejects.toMatchObject({ detail: { code: "RECOVERY_LEASE_MISMATCH" } });
    await pool.query("update sophia_voice_lab.browser_leases set worker_id=$2 where run_id=$1", [c.binding.runId,f.unsigned.allocatedWorkerId]);
    await expect(controls.settle(c.binding.runId, retained.version + 1, event, attempt)).rejects.toMatchObject({ detail: { code: "RECOVERY_VERSION_CONFLICT" } });
    expect(await controls.get(c.binding.runId)).toEqual(retained);
    await pool.query(`create function sophia_voice_lab.fence_test_abort() returns trigger language plpgsql as $$
      begin
        if exists(select 1 from sophia_voice_lab.browser_leases where run_id=NEW.run_id) then raise exception 'LEASE_NOT_REMOVED'; end if;
        raise exception 'FENCE_POST_LEASE_FAILURE';
      end $$`);
    await pool.query("create trigger fence_test_abort before update of generic_recovery_settlement on sophia_voice_lab.recovery_controls for each row execute function sophia_voice_lab.fence_test_abort()");
    try { await expect(controls.settle(c.binding.runId, retained.version, event, attempt)).rejects.toThrow("FENCE_POST_LEASE_FAILURE"); }
    finally {
      await pool.query("drop trigger fence_test_abort on sophia_voice_lab.recovery_controls");
      await pool.query("drop function sophia_voice_lab.fence_test_abort()");
    }
    expect(await controls.get(c.binding.runId)).toEqual(retained);
    expect((await pool.query("select count(*)::int as count from sophia_voice_lab.browser_leases where run_id=$1", [c.binding.runId])).rows[0].count).toBe(1);
    const settled = await controls.settle(c.binding.runId, retained.version, event, attempt);
    expect(settled).toMatchObject({ liveCleanupComplete: true, remotePurgeComplete: true,
      genericRecoverySettlement: { ready: true, ownerLossProofSha256: result.proof.proofSha256 } });
    expect((await pool.query("select count(*)::int as count from sophia_voice_lab.browser_leases where run_id=$1", [c.binding.runId])).rows[0].count).toBe(0);
    expect(await controls.settle(c.binding.runId, retained.version, event, attempt)).toEqual(settled);
    expect(await controls.persistGenericOwnerLoss(input)).toEqual({ ...result, replay: true, version: settled.version });
  });
  it("authenticates service-fence HTTP ingestion against the current repair release with real persistence", async () => {
    const f = serviceOwnerFenceFixture(new Date(Date.now() - 370000));
    const c = f.input.control;
    await pool.query(`insert into sophia_voice_lab.recovery_controls
      (run_id,test_run_id,cleanup_obligation_id,binding,version,browser_allocation_ever,browser_allocation_binding,
       generic_owner_dispatch,live_cleanup_complete,remote_purge_complete,content_purged_at)
      values ($1,$2,$3,$4,$5,true,$6,$7,false,false,$8)`,
      [c.binding.runId,c.binding.testRunId,c.binding.cleanupObligationId,c.binding,c.version,
        c.browserAllocationBinding,c.genericOwnerDispatch,c.contentPurgedAt]);
    const ledger = new PostgresVoiceLabLedger(url);
    try { await verifyServiceFenceHttp(ledger, f); } finally { await ledger.close(); }
  });
});
