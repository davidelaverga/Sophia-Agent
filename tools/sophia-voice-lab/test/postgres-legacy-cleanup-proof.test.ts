import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { composeServiceFenceV2Migration } from "../src/service-fence-migration.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";
import { completeExecutionCleanupFixture, recovery } from "./execution-cleanup-fixture.js";

const url = process.env.SOPHIA_VOICE_LAB_CONTROL_TEST_DATABASE_URL ?? "";
const suite = url ? describe : describe.skip;

suite("real PostgreSQL legacy (pre platform-fence) preserved cleanup proof", () => {
  let ledger: PostgresVoiceLabLedger;
  beforeAll(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_c4_control_[a-z0-9_]+$/.test(parsed.pathname) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated control-test database/reset approval required");
    ledger = new PostgresVoiceLabLedger(url, 4);
    expect((await ledger.pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    await ledger.pool.query("drop schema if exists sophia_voice_lab cascade");
    await ledger.pool.query(composeServiceFenceV2Migration(await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"), await readFile("migrations/004_recovery_controls.sql"),
      await readFile("migrations/005_service_owner_fence.sql"), await readFile("migrations/006_service_fence_v2.sql")).toString("utf8"));
  });
  afterAll(async () => {
    if (!ledger) return;
    try { await ledger.pool.query("drop schema if exists sophia_voice_lab cascade"); } finally { await ledger.close(); }
  });

  it("replays preservation and releases the recovered lease for a key-less 7d4-era proof", async () => {
    const run = testRun({ state: "failed_harness" });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 10, caller: 10 });
    const lease = await ledger.upsertBrowserLease(run.id, "old-process", 0);
    const all = completeExecutionCleanupFixture(run, lease.workerId, lease.leaseEpoch);
    for (const e of [all[0]!, all[1]!, all[4]!, recovery(run, 6)]) await ledger.appendEvent(run.id, e.kind, e.source, e.payload, e.dedupeKey ?? undefined);
    const current = await ledger.preserveRecoveryExecutionCleanup(run.id);
    // Rewrite the durable row to exactly what the deployed 7d4 worker stored.
    await ledger.pool.query("update sophia_voice_lab.recovery_controls set execution_cleanup_proof = execution_cleanup_proof #- '{eventSeqs,platformTerminated}' where run_id=$1", [run.id]);
    const legacy = (await ledger.getRecoveryControl(run.id))!;
    expect(legacy.executionCleanupProof!.eventSeqs).not.toHaveProperty("platformTerminated");
    expect(legacy.executionCleanupProof!.proofSha256).toBe(current.executionCleanupProof!.proofSha256);
    // Idempotent preservation replay must not report a conflict or rewrite the row.
    await expect(ledger.preserveRecoveryExecutionCleanup(run.id)).resolves.toEqual(legacy);
    expect((await ledger.pool.query("select execution_cleanup_proof #> '{eventSeqs}' ? 'platformTerminated' as present from sophia_voice_lab.recovery_controls where run_id=$1", [run.id])).rows[0].present).toBe(false);
    // Proof-gated release of the expired dead-owner lease now succeeds.
    expect(await ledger.releaseRecoveredBrowserLease(run.id)).toBe(true);
    expect(await ledger.getBrowserLease(run.id)).toBeNull();
  });
});
