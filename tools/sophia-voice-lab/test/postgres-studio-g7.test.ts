import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { LabEnvelope } from "../src/domain.js";
import { PostgresVoiceLabLedger } from "../src/postgres-ledger.js";
import { CapabilityCodec, sha256, type AuthenticatedCaller } from "../src/security.js";
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

/** Recovery results with a fresh global sign-out per call (as the real driver records them). */
function pgFreshRecovery() {
  let call = 0;
  return (id: string) => {
    call += 1;
    return [
      { kind: "studio.cleanup.exchange_ended", source: "canonical" as const, payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true, call }, dedupeKey: `pg-fresh-ended:${id}:${call}` },
      { kind: "studio.cleanup.signed_out", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `pg-fresh-${id}-${call}` }, dedupeKey: `pg-fresh-signed-out:${id}:${call}` },
    ];
  };
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
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `pg-recovery-ended:${runId}` },
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

    // Now past the JWT lifetime (and B's recovery backoff): B re-verifies the exchange is not live and releases the lease (quiesced, not closed).
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '2 hours' where run_id=$1 and kind='studio.cleanup.recovery_attempt'", [a.runId]);
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const released = (await ledger.pool.query("select payload from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_released'", [a.runId])).rows[0].payload;
    expect(released).toMatchObject({ schema: STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, dead_owner_quiesced: true, cas_deleted: true, browser_close: "unobservable_owner_dead" });
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: true });
    // Settled cleanup frees the admission slot.
    expect((await second.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-after-release") })).status).toBe("accepted");
  }, 120_000);

  it("releases by compare-and-delete the lease of a dead owner whose own cleanup for that lease epoch is durable (P2-1)", async () => {
    const a = await harness("pg-worker-a-cleaned");
    await a.worker.runOnce();
    await voice(a, "create");
    // A persisted its End: exchange ended, global sign-out, its own browser (this lease's execution epoch) closed; then died.
    await ledger.appendEvents(a.runId, [
      { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `pg-owner-ended:${a.runId}` },
      { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "held_session" }, dedupeKey: `pg-owner-signed-out:${a.runId}` },
      { kind: "cleanup.browser_context_closed", source: "browser", payload: { schema: "sophia_voice_lab_execution_epoch_browser_cleanup_v1", close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true, execution_epoch_sha256: sha256(`epoch:${a.runId}`) }, dedupeKey: `cleanup:${a.runId}:browser` },
    ]);
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const audio = new AudioResolver(config);
    await audio.initialize();
    const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    const workerB = new VoiceLabWorker("pg-worker-b-cleaned", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '10 minutes' where run_id=$1", [a.runId]);
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '10 minutes' where worker_id='pg-worker-a-cleaned'");
    for (let pass = 0; pass < 4 && (await ledger.getBrowserLease(a.runId)) !== null; pass += 1) await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const released = (await ledger.pool.query("select payload from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_released'", [a.runId])).rows[0].payload;
    expect(released).toMatchObject({ schema: STUDIO_DEAD_OWNER_LEASE_RELEASE_SCHEMA, cas_deleted: true, dead_owner_cleanup_complete: true, browser_close: "proven_by_owner_epoch" });
    expect(driverB.calls).not.toContain("recover");
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ cleanupComplete: true });
    const next = new VoiceLabService(ledger, config, async () => []);
    expect((await next.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-after-owner-cleanup") })).status).toBe("accepted");
  }, 120_000);

  it("stamps the dead-owner ordering events on the database clock, whatever the worker clock says (P3-6)", async () => {
    const a = await harness("pg-worker-skewed");
    await a.worker.runOnce();
    // A worker whose clock runs two hours behind the database.
    const skewed = new Date(Date.now() - 2 * 3_600_000);
    await ledger.appendEvents(a.runId, [{ kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", sign_out_id: randomUUID() }, dedupeKey: `pg-skewed-sign-out:${randomUUID()}`, observedAt: skewed }]);
    await ledger.appendEvent(a.runId, "studio.cleanup.dead_owner_verified", "worker", { verification_id: randomUUID(), exchange_not_live: true, signed_out: true }, `pg-skewed-verified:${randomUUID()}`, skewed);
    const ages = (await ledger.pool.query("select kind, extract(epoch from (clock_timestamp()-observed_at))::float8 as age_s from sophia_voice_lab.run_events where run_id=$1 and kind in ('studio.cleanup.signed_out','studio.cleanup.dead_owner_verified') order by seq", [a.runId])).rows;
    expect(ages).toHaveLength(2);
    for (const row of ages) expect(Math.abs(row.age_s), row.kind).toBeLessThan(60);
  }, 120_000);

  it("never treats a live owner as dead when its heartbeat clock runs behind the database's (P3-6)", async () => {
    const a = await harness("pg-worker-skewed");
    await a.worker.runOnce();
    // An owner whose clock runs 45 s behind heartbeated just now: it is alive, never stale.
    await ledger.pool.query("update sophia_voice_lab.runs set state='aborted_driver_restart' where id=$1", [a.runId]);
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '10 minutes' where run_id=$1", [a.runId]);
    await ledger.heartbeatWorker({ workerId: "pg-worker-skewed", serviceVersion: "x", browserReady: true, attestation: null, detail: {}, observedAt: new Date() });
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '45 seconds' where worker_id='pg-worker-skewed'");
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(a.runId, { verificationId: randomUUID(), tokenMaxLifetimeMs: 3_600_000, heartbeatStaleMs: 30_000 })).toEqual({ released: false, reason: "owner_heartbeat_live" });
    await ledger.pool.query("update sophia_voice_lab.runs set state='active' where id=$1", [a.runId]);
  }, 120_000);

  it("a worker clock ahead of the database runs no forced recovery before the database says the token lifetime elapsed (re-review P3)", async () => {
    const a = await harness("pg-worker-a-clock");
    await a.worker.runOnce();
    await voice(a, "create");
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const audio = new AudioResolver(config);
    await audio.initialize();
    const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    let attempt = 0;
    driverB.recoverResult = (runId) => {
      attempt += 1;
      return [
        { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `pg-clock-ended:${runId}` },
        { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `clock-${attempt}` }, dedupeKey: `pg-clock-signed-out:${runId}:${attempt}` },
      ];
    };
    const workerB = new VoiceLabWorker("pg-worker-b-clock", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '3 hours' where run_id=$1", [a.runId]);
    await workerB.maintainSessions();
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: false });
    // On the database clock the access-JWT lifetime since B's post-expiry sign-out elapses only in 30 s.
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=clock_timestamp()-interval '3570 seconds' where run_id=$1 and kind='studio.cleanup.signed_out'", [a.runId]);
    const before = driverB.calls.filter((call) => call === "recover").length;
    // Worker B's clock runs ten minutes ahead of the database.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 10 * 60_000));
    try { for (let pass = 0; pass < 5; pass += 1) await workerB.maintainSessions(); }
    finally { vi.useRealTimers(); }
    // Not even one: the database says the lifetime has not elapsed, and the
    // worker's clock is never consulted for that gate.
    expect(driverB.calls.filter((call) => call === "recover").length - before).toBe(0);
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
  }, 120_000);

  it("never deadlocks on PostgreSQL: a terminal run with a closed browser does not block a live run's recovery (third review P2)", async () => {
    const h = await harness("pg-deadlock");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("pg-deadlock-end-1"), wait_timeout_ms: 5_000 }));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    const second = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-deadlock-second") });
    const run2Id = second.run_id!;
    await h.worker.runOnce();
    expect(await ledger.getRun(run2Id)).toMatchObject({ state: "ready" });
    h.driver.recoverResult = pgFreshRecovery();
    await h.worker.maintainSessions();
    expect(h.driver.calls).not.toContain("recover");
    // Run 1's certification deadline passes (database clock) while run 2 is live.
    await ledger.pool.query("update sophia_voice_lab.runs set expires_at=clock_timestamp()-interval '1 second' where id=$1", [h.runId]);
    await h.worker.maintainSessions();
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "failed_harness", cleanupComplete: false });
    // Run 2's End cannot prove ownership: an API-only re-verification is needed.
    h.driver.endExchangeConfirmed = false;
    const endKey = newIdempotencyKey("pg-deadlock-end-2");
    await h.service.queueRunOperation(caller, run2Id, "end", endKey, { run_id: run2Id, idempotency_key: endKey });
    for (let step = 0; step < 5 && await h.worker.runOnce(); step += 1) { /* execute the End */ }
    for (let pass = 0; pass < 6; pass += 1) {
      const [first, latest] = [await ledger.getRun(h.runId), await ledger.getRun(run2Id)];
      if (first?.cleanupComplete && latest?.cleanupComplete) break;
      await h.worker.maintainSessions();
    }
    expect(await ledger.getRun(run2Id)).toMatchObject({ cleanupComplete: true });
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "failed_harness", cleanupComplete: true });
    expect((await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-deadlock-third") })).status).toBe("accepted");
  }, 120_000);

  it("refuses an admission that arrives while a global sign-out is in flight on PostgreSQL (third review P3 residual 2)", async () => {
    const h = await harness("pg-fence-worker");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("pg-fence-end"), wait_timeout_ms: 5_000 }));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    let admission: unknown = null;
    h.driver.recoverHook = async () => { admission = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-racing-start") }).catch((error: unknown) => error); };
    h.driver.recoverResult = pgFreshRecovery();
    await h.worker.maintainSessions();
    expect(h.driver.calls).toContain("recover");
    expect(admission).toMatchObject({ detail: { code: "STUDIO_GLOBAL_SIGNOUT_PENDING" } });
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
    expect((await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("pg-after-fence") })).status).toBe("accepted");
  }, 120_000);

  it("serializes the global sign-out fence with admission for two interleaved callers (third review P3 residual 2)", async () => {
    const h = await harness("pg-fence-ledger");
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const service = new VoiceLabService(ledger, config, async () => []);
    // Run 1 awaits evidence with its cleanup complete: it holds no admission and no live session.
    const settleRun1 = async () => {
      await ledger.pool.query("update sophia_voice_lab.runs set state='pending_external_evidence',cleanup_complete=true where id=$1", [h.runId]);
      await ledger.pool.query("update sophia_voice_lab.recovery_controls set live_cleanup_complete=true where run_id=$1", [h.runId]);
      await ledger.pool.query("update sophia_voice_lab.operations set state='cancelled' where run_id=$1 and state in ('queued','leased','executing')", [h.runId]);
    };
    await settleRun1();
    let refused = 0, deferred = 0;
    for (let round = 0; round < 8; round += 1) {
      const markerId = randomUUID();
      const order = round % 3;
      const fence = () => ledger.beginStudioGlobalSignOut(h.runId, markerId);
      const admit = () => service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey(`pg-interleave-${round}`) });
      let fenceResult: { granted: boolean } | null = null;
      let admission: unknown;
      if (order === 0) { fenceResult = await fence(); admission = await admit().catch((error: unknown) => error); }
      else if (order === 1) { admission = await admit().catch((error: unknown) => error); fenceResult = await fence(); }
      else { const [a, b] = await Promise.all([fence(), admit().catch((error: unknown) => error)]); fenceResult = a; admission = b; }
      const admitted = (admission as { status?: string }).status === "accepted";
      // Never both: an admission is refused while the fence is set, and the fence is never granted over a live run.
      expect(fenceResult!.granted && admitted, `round ${round}`).toBe(false);
      expect(fenceResult!.granted || admitted, `round ${round}`).toBe(true);
      if (fenceResult!.granted) { refused += 1; expect(admission, `round ${round}`).toMatchObject({ detail: { code: "STUDIO_GLOBAL_SIGNOUT_PENDING" } }); await ledger.endStudioGlobalSignOut(h.runId, markerId, "abandoned"); }
      else deferred += 1;
      // Reset: the admitted run (if any) ends; run 1 is back to awaiting evidence.
      await ledger.pool.query("update sophia_voice_lab.runs set state='aborted_driver_restart',cleanup_complete=true where id<>$1 and state not in ('aborted_driver_restart','completed')", [h.runId]);
      await ledger.pool.query("update sophia_voice_lab.recovery_controls set live_cleanup_complete=true where run_id<>$1", [h.runId]);
      await ledger.pool.query("update sophia_voice_lab.operations set state='cancelled' where state in ('queued','leased','executing')");
      await settleRun1();
    }
    expect(refused).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(0);
  }, 120_000);

  it("re-checks a G7 step when the worker executes it: a second operation of a performed step is refused (P3-3)", async () => {
    const h = await harness("pg-worker-step");
    await h.worker.runOnce();
    expect((await action(h, { action: "leave_and_return" })).data).toMatchObject({ performed: true });
    // A row the ledger guard never saw (written before the guard existed).
    const rowId = randomUUID();
    await ledger.pool.query("insert into sophia_voice_lab.operations (id,run_id,caller_id,type,state,idempotency_key,request_hash,input) values ($1,$2,$3,'studio_action','queued',$4,$5,$6)",
      [rowId, h.runId, caller.subject, newIdempotencyKey("pg-legacy-row"), "f".repeat(64), { run_id: h.runId, action: "leave_and_return" }]);
    while (await h.worker.runOnce()) { /* drain */ }
    expect(await ledger.getOperation(rowId)).toMatchObject({ state: "failed", error: { code: "STUDIO_G7_STEP_ALREADY_PERFORMED" } });
    expect(h.driver.calls.filter((call) => call === "action:leave_and_return")).toHaveLength(1);
    // The ledger itself refuses a new operation for a performed step, whatever its key.
    await expect(ledger.createOperation({ id: randomUUID(), runId: h.runId, callerId: caller.subject, type: "studio_action", idempotencyKey: newIdempotencyKey("pg-again"), requestHash: "e".repeat(64), input: { run_id: h.runId, action: "leave_and_return" } })).rejects.toMatchObject({ detail: { code: "STUDIO_G7_STEP_ALREADY_PERFORMED" } });
  }, 120_000);
});
