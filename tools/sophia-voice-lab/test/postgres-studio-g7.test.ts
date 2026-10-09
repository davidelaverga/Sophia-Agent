import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { LabEnvelope } from "../src/domain.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { CapabilityCodec, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { composeStudioG7OperationsMigration } from "../src/service-fence-migration.js";
import { STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA } from "../src/studio-g7/lease-release.js";
import { VoiceLabWorker } from "../src/worker.js";
import { EXCHANGE_UUID, studioTestConfig } from "./studio-g7-helpers.js";
import { ScriptedStudioDriver, newIdempotencyKey } from "./studio-g7-worker-helpers.js";

/**
 * The Studio G7 worker branches against real, disposable PostgreSQL (schema
 * v7): the new `studio_action` operation type, admission while a Studio run
 * or its cleanup is outstanding, the evidence completion path, and the dead
 * foreign worker's lease release evaluated on the database clock.
 */
const url = process.env.SOPHIA_VOICE_LAB_STUDIO_TEST_DATABASE_URL ?? "";
const selected = url ? describe : describe.skip;
const caller: AuthenticatedCaller = { subject: "studio-pg-caller", scopes: new Set(["voice_lab:read", "voice_lab:run"]) };
const START = { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1" } as const;
let ledger: PostgresVoiceLabLedger;

interface Harness { service: VoiceLabService; driver: ScriptedStudioDriver; worker: VoiceLabWorker; runId: string }

async function harness(workerId: string): Promise<Harness> {
  const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
  const audio = new AudioResolver(config);
  await audio.initialize();
  const service = new VoiceLabService(ledger, config, async () => audio.summaries());
  const started = await service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-studio-start") });
  const run = (await ledger.getRun(started.run_id!))!;
  const driver = new ScriptedStudioDriver(run);
  const worker = new VoiceLabWorker(workerId, ledger, config, audio, driver as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  return { service, driver, worker, runId: run.id };
}

async function drive(h: Harness, call: Promise<LabEnvelope>): Promise<LabEnvelope> {
  let settled = false;
  const result = call.finally(() => { settled = true; });
  while (!settled) { if (!(await h.worker.runOnce())) await delay(10); }
  return result;
}
const voice = (h: Harness, step: string) => drive(h, h.service.studioG7VoiceStep(caller, { run_id: h.runId, step, fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey(`pg-voice-${step}`) }));
const action = (h: Harness, input: Record<string, unknown>) => drive(h, h.service.studioG7Action(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey(`pg-action-${String(input.action)}`), ...input }));

async function episode(h: Harness): Promise<void> {
  await h.worker.runOnce();
  for (const step of ["create", "steer"]) expect((await voice(h, step)).status).toBe("completed");
  expect((await action(h, { action: "leave_and_return" })).data).toMatchObject({ performed: true });
  expect((await action(h, { action: "section_revision", instruction: "Shorten the introduction" })).data).toMatchObject({ performed: true });
  expect((await action(h, { action: "stale_edit" })).data).toMatchObject({ performed: true, code: "stale_revision" });
  for (const step of ["hold", "resume", "stop"]) {
    expect((await voice(h, step)).status).toBe("completed");
    await action(h, { action: "observe", for_step: step });
  }
  expect((await action(h, { action: "withdrawal" })).data).toMatchObject({ performed: true });
}

selected("real PostgreSQL Studio G7 worker branches (schema v7)", () => {
  beforeEach(async () => {
    const parsed = new URL(url);
    if (!/^\/voice_lab_test_studio_[a-z0-9_]+$/.test(parsed.pathname) || process.env.SOPHIA_VOICE_LAB_TEST_DATABASE_RESET_APPROVED !== "YES") throw new Error("Dedicated Studio test database/reset approval required");
    ledger = new PostgresVoiceLabLedger(url, 4, "synthetic-studio-retention-key-000000000001");
    expect((await ledger.pool.query("select current_database() as name")).rows[0].name).toBe(parsed.pathname.slice(1));
    await ledger.pool.query("drop schema if exists sophia_voice_lab cascade");
    await ledger.pool.query(composeStudioG7OperationsMigration(
      await readFile("../../backend/migrations/2026_08_23_sophia_voice_lab.sql"),
      await readFile("migrations/004_recovery_controls.sql"),
      await readFile("migrations/005_service_owner_fence.sql"),
      await readFile("migrations/006_service_fence_v2.sql"),
      await readFile("migrations/007_studio_g7_operations.sql"),
    ).toString("utf8"));
  });
  afterEach(async () => {
    if (!ledger) return;
    try { await ledger.pool.query("drop schema if exists sophia_voice_lab cascade"); }
    finally { await ledger.close(); }
  });

  it("persists every G7 step as a durable operation, holds admission, and completes the run", async () => {
    const h = await harness("pg-studio-worker");
    await episode(h);
    const types = (await ledger.pool.query("select type, count(*)::int as n from sophia_voice_lab.operations where run_id=$1 group by type order by type", [h.runId])).rows;
    expect(types).toEqual([{ type: "speak", n: 5 }, { type: "start", n: 1 }, { type: "studio_action", n: 7 }]);
    // Concurrency 1: a second Studio run is not admitted while this one is live.
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const second = new VoiceLabService(ledger, config, async () => []);
    await expect(second.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-studio-second") })).rejects.toMatchObject({ detail: { code: expect.stringMatching(/CONCURRENCY|LIMIT/) } });
    await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("pg-end"), wait_timeout_ms: 5_000 }));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true, verdicts: { harness: "pass", product: "inconclusive", evidence: "pass" } });
    expect(await ledger.getBrowserLease(h.runId)).toBeNull();
    // Settled cleanup releases admission.
    const admitted = await second.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-studio-after") });
    expect(admitted.status).toBe("accepted");
  }, 120_000);

  it("finalizes a run whose late receipts arrive after End through the evidence completion path", async () => {
    const h = await harness("pg-studio-late");
    h.driver.lateSessionClosed = true;
    await episode(h);
    await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("pg-end-late"), wait_timeout_ms: 5_000 }));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    await h.worker.maintainSessions();
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", verdicts: { harness: "pass", evidence: "pass" } });
    const attempts = (await ledger.pool.query("select count(*)::int as n from sophia_voice_lab.run_events where run_id=$1 and kind='studio.evidence.refresh'", [h.runId])).rows[0].n;
    expect(attempts).toBe(1);
  }, 120_000);

  it("keeps a dead foreign worker's lease and the admission slot until the owner's browser can no longer act, then releases it on the database clock", async () => {
    const a = await harness("pg-worker-a-dies");
    await a.worker.runOnce();
    await voice(a, "create");
    expect(await ledger.getBrowserLease(a.runId)).toMatchObject({ workerId: "pg-worker-a-dies" });
    // Worker B: a fresh process whose driver retains nothing about the run.
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const audio = new AudioResolver(config);
    await audio.initialize();
    const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    driverB.recoverResult = (runId) => [
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot" }, dedupeKey: `pg-recovery-ended:${runId}` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant" }, dedupeKey: `pg-recovery-signed-out:${runId}` },
    ];
    const workerB = new VoiceLabWorker("pg-worker-b", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    // A's lease expires (database clock).
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '3 hours' where run_id=$1", [a.runId]);
    await workerB.maintainSessions();
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: false });
    expect(driverB.adopted).toMatchObject({ exchangeId: EXCHANGE_UUID, speakRequested: true });
    // The sign-out B just confirmed is recent: A's access JWTs could still be valid.
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    const second = new VoiceLabService(ledger, config, async () => []);
    await expect(second.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-blocked") })).rejects.toMatchObject({ detail: { code: expect.stringMatching(/CONCURRENCY|LIMIT|CLEANUP/) } });

    // Adversarial checks on the database transaction itself.
    const proof = { verificationId: randomUUID(), tokenMaxLifetimeMs: 3_600_000, heartbeatStaleMs: 30_000 };
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(a.runId, proof)).toEqual({ released: false, reason: "access_token_lifetime_pending" });
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=clock_timestamp()-interval '2 hours' where run_id=$1 and kind='studio.cleanup.signed_out'", [a.runId]);
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(a.runId, proof)).toEqual({ released: false, reason: "fresh_exchange_verification_missing" });
    await ledger.heartbeatWorker({ workerId: "pg-worker-a-dies", serviceVersion: "x", browserReady: true, attestation: null, detail: {}, observedAt: new Date() });
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(a.runId, proof)).toEqual({ released: false, reason: "owner_heartbeat_live" });
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '10 minutes' where worker_id='pg-worker-a-dies'");
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(randomUUID(), proof)).toMatchObject({ released: false });

    // Now past the JWT lifetime: B re-verifies the exchange is not live and releases the lease (quiesced, not closed).
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const released = (await ledger.pool.query("select payload from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_released'", [a.runId])).rows[0].payload;
    expect(released).toMatchObject({ schema: STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, dead_owner_quiesced: true, cas_deleted: true, browser_close: "unobservable_owner_dead" });
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: true });
    // Settled cleanup frees the admission slot.
    expect((await second.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-after-release") })).status).toBe("accepted");
  }, 120_000);
});
