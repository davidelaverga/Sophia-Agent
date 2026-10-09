import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { LabEnvelope } from "../src/domain.js";
import type { VoiceLabLedger } from "../src/ledger.js";
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

function pgDeferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

/** Root's synchronization: both workers reach begin after their initial reads; B's begin runs first, then A's. */
function pgSynchronizedBegins(shared: VoiceLabLedger) {
  const arrived = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const bDone = pgDeferred();
  const results: Record<string, { granted: boolean; reason?: string }> = {};
  const view = (label: "a" | "b") => new Proxy(shared, {
    get(target, property) {
      if (property === "beginStudioGlobalSignOut") {
        return async (...args: unknown[]) => {
          const gate = pgDeferred();
          arrived.set(label, gate);
          if (arrived.size === 2) void (async () => { arrived.get("b")!.resolve(); await bDone.promise; arrived.get("a")!.resolve(); })();
          await gate.promise;
          try {
            const result = await (target.beginStudioGlobalSignOut as (...input: unknown[]) => Promise<{ granted: boolean; reason?: string }>).apply(target, args);
            results[label] = result;
            return result;
          } finally { if (label === "b") bDone.resolve(); }
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as VoiceLabLedger;
  return { view, results };
}

/** A run pending external evidence whose evidence-refresh session could not be revoked (it needs a global sign-out). */
async function pgPendingWithUnrevokedRefresh(label: string): Promise<Harness> {
  const h = await harness(`${label}-owner`);
  h.driver.lateSessionClosed = true;
  h.driver.refreshRevokeConfirmed = false;
  await episode(h);
  await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey(`${label}-end`), wait_timeout_ms: 5_000 }));
  const other = await h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey(`${label}-other`) });
  await h.worker.maintainSessions();
  const finished = (await ledger.getRun(other.run_id!))!;
  await ledger.updateRun(finished.id, finished.version, { state: "aborted_driver_restart", cleanupComplete: true });
  expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
  return h;
}

async function pgRecoveryWorker(h: Harness, workerId: string, view: VoiceLabLedger) {
  const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
  const audio = new AudioResolver(config);
  await audio.initialize();
  const driver = new ScriptedStudioDriver((await ledger.getRun(h.runId))!);
  driver.recoverResult = pgFreshRecovery();
  const worker = new VoiceLabWorker(workerId, view, config, audio, driver as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  // As the worker's own heartbeat loop does: its attestation names its process boot.
  await pgBootBeat(workerId, worker);
  return { driver, worker };
}

/** A heartbeat of this worker process (its attestation's boot id, as its own heartbeat loop records it). */
function pgBootBeat(workerId: string, worker: VoiceLabWorker | { workerBootIdSha256: string }, observedAt = new Date()) {
  return ledger.heartbeatWorker({ workerId, serviceVersion: "test", browserReady: true, attestation: { worker_boot_id_sha256: worker.workerBootIdSha256 } as never, detail: {}, observedAt });
}

const pgFenceEvents = async (runId: string) => (await ledger.listEvents(runId, 0, 2_000)).events.filter((event) => event.kind === "studio.cleanup.global_sign_out_pending" || event.kind === "studio.cleanup.global_sign_out_cleared");
const pgTryStart = (h: Harness, key: string) => h.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey(key) }).then((started) => started.status, (error: { detail?: { code?: string } }) => error.detail?.code ?? "error");

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

  it("keeps a dead owner's lease on PostgreSQL while a fresh report places the principal in the room, and a later stale one (even with an overlapping recovery) never releases it: only a later fresh absent does (A15 live presence, P3-2)", async () => {
    const a = await harness("pg-worker-a-present");
    await a.worker.runOnce();
    await voice(a, "create");
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const audio = new AudioResolver(config);
    await audio.initialize();
    const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    let presence: { status: string; reason: string | null } = { status: "present", reason: null };
    let read = 0;
    driverB.recoverResult = (runId) => {
      read += 1;
      return [
        { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `pg-presence-ended:${runId}` },
        { kind: "studio.room.live_presence", source: "canonical", payload: { schema: "sophia_voice_lab_studio_room_presence_v1", purpose: "recover", status: presence.status, reason: presence.reason, http_status: 200, observation_id: `pg-presence-${read}`, identities_excluded: true }, dedupeKey: `pg-presence:${runId}:${read}` },
        { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `pg-presence-${read}` }, dedupeKey: `pg-presence-signed-out:${runId}:${read}` },
      ];
    };
    const workerB = new VoiceLabWorker("pg-worker-b-presence", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '3 hours' where run_id=$1", [a.runId]);
    await workerB.maintainSessions();
    await workerB.maintainSessions();
    expect(await ledger.getRun(a.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: false });
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '10 minutes' where worker_id='pg-worker-a-present'");
    // Past the JWT lifetime (database clock) and the recovery backoff.
    const age = async () => {
      await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '2 hours' where run_id=$1 and kind in ('studio.cleanup.signed_out','studio.cleanup.recovery_attempt')", [a.runId]);
    };
    await age();
    await workerB.maintainSessions();
    // A fresh report places the principal in the room: the database transaction keeps the lease.
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    const pendingReasons = (await ledger.pool.query("select payload->>'dead_owner_release' as reason from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_unconfirmed'", [a.runId])).rows.map((row) => row.reason);
    expect(pendingReasons).toContain("principal_present_in_room");
    // A later stale report is not evidence of absence, and after a present it never releases: the latest
    // decisive verification still says present. A second worker's recovery overlapping it is refused.
    presence = { status: "unobservable", reason: "report_stale" };
    await age();
    const held = pgDeferred();
    const inFlight = pgDeferred();
    driverB.recoverHook = async () => { inFlight.resolve(); await held.promise; };
    const driverC = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    driverC.recoverResult = driverB.recoverResult;
    const workerC = new VoiceLabWorker("pg-worker-c-presence", ledger, config, audio, driverC as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    const bPass = workerB.maintainSessions();
    await inFlight.promise;
    await workerC.maintainSessions();
    expect(driverC.calls).not.toContain("recover");
    held.resolve();
    await bPass;
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    expect((await ledger.pool.query("select payload->>'room_presence' as presence from sophia_voice_lab.run_events where run_id=$1 and kind='studio.cleanup.dead_owner_verified' order by seq", [a.runId])).rows.map((row) => row.presence)).toEqual(["present", "unobservable"]);
    // A later fresh absent releases it.
    presence = { status: "absent", reason: null };
    driverB.recoverHook = null;
    await age();
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const released = (await ledger.pool.query("select payload from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_released'", [a.runId])).rows[0].payload;
    expect(released).toMatchObject({ dead_owner_quiesced: true, room_presence: "absent", room_presence_reason: null });
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

  it("never publishes a failure-shaped manifest for a run awaiting evidence whose fenced sign-out was abandoned, on PostgreSQL (fourth review P3)", async () => {
    const h = await harness("pg-abandoned-fence");
    h.driver.lateSessionClosed = true;
    h.driver.refreshRevokeConfirmed = false;
    await episode(h);
    await drive(h, h.service.endVoiceRun(caller, { run_id: h.runId, idempotency_key: newIdempotencyKey("pg-abandoned-end"), wait_timeout_ms: 5_000 }));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: true });
    // The first fenced global sign-out fails (the marker is abandoned); the next one lands.
    const fresh = pgFreshRecovery();
    let calls = 0;
    h.driver.recoverResult = (id) => {
      calls += 1;
      return fresh(id).map((event) => calls === 1 && event.kind === "studio.cleanup.signed_out"
        ? { ...event, payload: { ...event.payload, confirmed: false, http_status: 503, basis: "unreachable" }, dedupeKey: `pg-abandoned-sign-out:${id}` }
        : event);
    };
    await h.worker.maintainSessions();
    expect(calls).toBe(1);
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "pending_external_evidence", cleanupComplete: false });
    for (let pass = 0; pass < 4 && (await ledger.getRun(h.runId))?.state !== "completed"; pass += 1) {
      // The recovery backoff elapses on the database clock.
      await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=clock_timestamp()-interval '31 seconds' where run_id=$1 and kind='studio.cleanup.recovery_attempt'", [h.runId]);
      await h.worker.maintainSessions();
    }
    expect(calls).toBeGreaterThanOrEqual(2);
    const published = (await ledger.listArtifacts(h.runId))
      .filter((artifact) => artifact.kind === "manifest_attachment")
      .map((artifact) => JSON.parse(Buffer.from(artifact.bytes).toString("utf8")) as Record<string, unknown>);
    expect(published.length).toBeGreaterThan(0);
    for (const manifest of published) {
      expect(manifest.terminal_reason).not.toBe("RECOVERY_PENDING");
      expect(manifest.terminal_reason).not.toBe("TERMINAL_CERTIFICATION_REVISION");
      if (manifest.terminal_state === "pending_external_evidence") expect(manifest.terminal_error).toBeNull();
    }
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true, terminalError: null, verdicts: { harness: "pass", evidence: "pass" } });
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
      const fence = () => ledger.beginStudioGlobalSignOut(h.runId, markerId, "pg-interleave-worker");
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

  it("root P2 on PostgreSQL: serializes two workers' begins for the same run; admission stays closed until B's sign-out finished", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-root");
    const sync = pgSynchronizedBegins(ledger);
    const a = await pgRecoveryWorker(h, "pg-fence-root-a", sync.view("a"));
    const b = await pgRecoveryWorker(h, "pg-fence-root-b", sync.view("b"));
    const held = pgDeferred();
    const inFlight = pgDeferred();
    b.driver.recoverHook = async () => { inFlight.resolve(); await held.promise; };
    const bPass = b.worker.maintainSessions();
    const aPass = a.worker.maintainSessions();
    await inFlight.promise;
    await aPass;
    expect(await pgTryStart(h, "pg-root-during")).toBe("STUDIO_GLOBAL_SIGNOUT_PENDING");
    expect(sync.results.b).toMatchObject({ granted: true });
    expect(sync.results.a).toMatchObject({ granted: false, reason: "sign_out_in_flight" });
    expect((await pgFenceEvents(h.runId)).filter((event) => event.kind === "studio.cleanup.global_sign_out_pending")).toHaveLength(1);
    held.resolve();
    await bPass;
    expect(b.driver.globalLogouts).toEqual([h.runId]);
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
    expect(await pgTryStart(h, "pg-root-after")).toBe("accepted");
  }, 120_000);

  for (const mode of ["rejected", "abandoned"] as const) {
    it(`a ${mode} recovery on PostgreSQL holds admission while in flight, frees only its own marker, and the other worker then completes the run`, async () => {
      const h = await pgPendingWithUnrevokedRefresh(`pg-${mode}`);
      const sync = pgSynchronizedBegins(ledger);
      const a = await pgRecoveryWorker(h, `pg-fence-${mode}-a`, sync.view("a"));
      const b = await pgRecoveryWorker(h, `pg-fence-${mode}-b`, sync.view("b"));
      const held = pgDeferred();
      const inFlight = pgDeferred();
      b.driver.recoverHook = async () => { inFlight.resolve(); await held.promise; if (mode === "abandoned") throw new Error("recovery aborted"); };
      b.driver.recoverResult = (id) => pgFreshRecovery()(id).map((event) => event.kind === "studio.cleanup.signed_out" ? { ...event, payload: { ...event.payload, confirmed: false, http_status: 401, basis: "rejected" }, dedupeKey: `pg-rejected:${id}` } : event);
      const bPass = b.worker.maintainSessions().catch(() => undefined);
      const aPass = a.worker.maintainSessions();
      await inFlight.promise;
      await aPass;
      expect(await pgTryStart(h, `pg-${mode}-during`)).toBe("STUDIO_GLOBAL_SIGNOUT_PENDING");
      expect(sync.results.a).toMatchObject({ granted: false, reason: "sign_out_in_flight" });
      held.resolve();
      await bPass;
      expect((await pgFenceEvents(h.runId)).filter((event) => event.kind === "studio.cleanup.global_sign_out_cleared").map((event) => event.payload.outcome)).toEqual(["abandoned"]);
      expect(await ledger.getRun(h.runId)).toMatchObject({ cleanupComplete: false });
      await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '2 minutes' where run_id=$1 and kind='studio.cleanup.recovery_attempt'", [h.runId]);
      await a.worker.maintainSessions();
      await a.worker.maintainSessions();
      expect(a.driver.globalLogouts).toEqual([h.runId]);
      expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
      expect(await pgTryStart(h, `pg-${mode}-after`)).toBe("accepted");
    }, 120_000);
  }

  it("on PostgreSQL takes over only a marker whose owner provably died holding it; the dead owner's late logout is withheld", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-stale");
    const b = await pgRecoveryWorker(h, "pg-fence-stale-b", ledger);
    const held = pgDeferred();
    const inFlight = pgDeferred();
    b.driver.recoverHook = async () => { inFlight.resolve(); await held.promise; };
    const bPass = b.worker.maintainSessions();
    await inFlight.promise;
    const a = await pgRecoveryWorker(h, "pg-fence-stale-a", ledger);
    const ageAttempts = () => ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '2 minutes' where run_id=$1 and kind='studio.cleanup.recovery_attempt'", [h.runId]);
    // Young marker, owner heartbeat fresh: nobody takes over.
    await ageAttempts();
    await a.worker.maintainSessions();
    expect(a.driver.calls).not.toContain("recover");
    expect(await pgTryStart(h, "pg-stale-young")).toBe("STUDIO_GLOBAL_SIGNOUT_PENDING");
    // On the database clock: the marker and its owner's heartbeat are older than the owner-stale bound.
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '5 minutes' where run_id=$1 and kind='studio.cleanup.global_sign_out_pending'", [h.runId]);
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '5 minutes' where worker_id='pg-fence-stale-b'");
    await ageAttempts();
    const aHeld = pgDeferred();
    const aInFlight = pgDeferred();
    a.driver.recoverHook = async () => { aInFlight.resolve(); await aHeld.promise; };
    const aPass = a.worker.maintainSessions();
    await aInFlight.promise;
    // B wakes while A (which took over) is in flight: B's logout is withheld, and B clearing its own marker never clears A's.
    held.resolve();
    await bPass;
    expect(b.driver.globalLogouts).toEqual([]);
    expect(b.driver.withheldLogouts).toEqual([h.runId]);
    expect(await pgTryStart(h, "pg-stale-during")).toBe("STUDIO_GLOBAL_SIGNOUT_PENDING");
    aHeld.resolve();
    await aPass;
    await a.worker.maintainSessions();
    expect(a.driver.globalLogouts).toEqual([h.runId]);
    expect((await pgFenceEvents(h.runId)).filter((event) => event.kind === "studio.cleanup.global_sign_out_cleared").map((event) => event.payload.outcome)).toEqual(["abandoned_owner_dead", "abandoned", "confirmed"]);
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
    expect(await pgTryStart(h, "pg-stale-after")).toBe("accepted");
  }, 120_000);

  it("on PostgreSQL grants exactly one of two truly concurrent begins for the same run (the admission lock serializes them)", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-concurrent");
    // Hold both transactions at their marker insert: only the lock order decides.
    const blocker = await ledger.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("lock table sophia_voice_lab.run_events in share row exclusive mode");
      const both = Promise.all([ledger.beginStudioGlobalSignOut(h.runId, randomUUID(), "pg-concurrent-a"), ledger.beginStudioGlobalSignOut(h.runId, randomUUID(), "pg-concurrent-b")]);
      await delay(400);
      await blocker.query("rollback");
      const results = await both;
      expect(results.filter((result) => result.granted)).toHaveLength(1);
      expect(results.find((result) => !result.granted)).toMatchObject({ reason: "sign_out_in_flight" });
    } finally { blocker.release(); }
    expect((await pgFenceEvents(h.runId)).filter((event) => event.kind === "studio.cleanup.global_sign_out_pending")).toHaveLength(1);
  }, 120_000);

  it("positive control on PostgreSQL: a single worker's fenced recovery logs out while it holds its marker, clears it, and admission reopens", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-single");
    const a = await pgRecoveryWorker(h, "pg-fence-single-a", ledger);
    await a.worker.maintainSessions();
    expect(a.driver.gateChecks).toBe(1);
    expect(a.driver.globalLogouts).toEqual([h.runId]);
    const events = await pgFenceEvents(h.runId);
    expect(events.map((event) => [event.kind, event.payload.marker_id === events[0]!.payload.marker_id])).toEqual([["studio.cleanup.global_sign_out_pending", true], ["studio.cleanup.global_sign_out_cleared", true]]);
    expect(events[0]!.payload.owner_worker_id_sha256).toBe(sha256("pg-fence-single-a"));
    expect(await ledger.getRun(h.runId)).toMatchObject({ state: "completed", cleanupComplete: true });
    expect(await pgTryStart(h, "pg-single-after")).toBe("accepted");
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
  // ------------------------------------------------------------------ delta 5
  const pgOutstanding = async (runId: string) => {
    const { studioOutstandingSignOutMarkers } = await import("../src/studio-g7/sign-out-fence.js");
    return studioOutstandingSignOutMarkers((await ledger.listEvents(runId, 0, 5_000)).events).map((marker) => marker.markerId);
  };
  const pgCleared = async (runId: string) => (await pgFenceEvents(runId)).filter((event) => event.kind === "studio.cleanup.global_sign_out_cleared").map((event) => event.payload.outcome);
  const backdateMarker = (runId: string, marker: string) => ledger.pool.query("update sophia_voice_lab.run_events set observed_at = observed_at - interval '10 minutes' where run_id=$1 and kind='studio.cleanup.global_sign_out_pending' and payload->>'marker_id'=$2", [runId, marker]);

  it("delta 5 PG-W2/W3 on PostgreSQL: a marker whose owner id heartbeats from another boot is abandoned and taken over; an abandoned marker is held by nobody", async () => {
    const h = await harness("pg-d5-w2");
    const OWNER = "srv-abcdefghij0123456789-5d8f9c7b6-xk2lp";
    const bootA = { workerBootIdSha256: "a".repeat(64) }, bootB = { workerBootIdSha256: "b".repeat(64) };
    expect(await ledger.beginStudioGlobalSignOut(h.runId, "m1", OWNER, bootA.workerBootIdSha256)).toMatchObject({ granted: true });
    await backdateMarker(h.runId, "m1");
    // The same boot heartbeating: alive, never taken over, still held.
    await pgBootBeat(OWNER, bootA);
    expect(await ledger.beginStudioGlobalSignOut(h.runId, "m2", "pg-d5-other", "c".repeat(64))).toMatchObject({ granted: false, reason: "sign_out_in_flight" });
    expect(await ledger.holdsStudioGlobalSignOut(h.runId, "m1")).toBe(true);
    expect(await pgTryStart(h, "pg-d5-w2-alive")).toBe("STUDIO_GLOBAL_SIGNOUT_PENDING");
    // The instance id restarted (another boot heartbeats under it): the writer of m1 is gone.
    await pgBootBeat(OWNER, bootB);
    // P3-1: nobody holds an abandoned marker, so its stale owner can never log out globally.
    expect(await ledger.holdsStudioGlobalSignOut(h.runId, "m1")).toBe(false);
    expect(await ledger.beginStudioGlobalSignOut(h.runId, "m3", "pg-d5-other", "c".repeat(64))).toMatchObject({ granted: true });
    expect(await pgCleared(h.runId)).toEqual(["abandoned_owner_dead"]);
    expect(await pgOutstanding(h.runId)).toEqual(["m3"]);
  }, 120_000);

  it("delta 5 PG-W2 heals on PostgreSQL: a worker restarted under the same instance id clears its previous boot's marker; the run recovers and admission reopens", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-d5-restart");
    const id = "srv-abcdefghij0123456789-5d8f9c7b6-pg2lp";
    const crashed = await pgRecoveryWorker(h, id, ledger);
    const inFlight = pgDeferred();
    crashed.driver.recoverHook = async () => { inFlight.resolve(); await new Promise(() => undefined); }; // the process dies here
    void crashed.worker.maintainSessions();
    await inFlight.promise;
    expect(await pgOutstanding(h.runId)).toHaveLength(1);
    const restarted = await pgRecoveryWorker(h, id, ledger);
    for (let pass = 0; pass < 6 && await pgTryStart(h, `pg-d5-restart-${pass}`).then((status) => status !== "accepted"); pass += 1) {
      await restarted.worker.maintainSessions();
      await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '2 minutes' where run_id=$1 and kind='studio.cleanup.recovery_attempt'", [h.runId]);
      await pgBootBeat(id, restarted.worker);
    }
    expect(await pgCleared(h.runId)).toEqual(expect.arrayContaining(["abandoned_owner_restarted"]));
    expect(await pgOutstanding(h.runId)).toEqual([]);
    expect(restarted.driver.calls).toContain("recover");
    expect(await ledger.getRun(h.runId)).toMatchObject({ cleanupComplete: true });
  }, 120_000);

  it("delta 5 PG-W1 heals on PostgreSQL: a clear that failed is retried by its live owner from the durable marker", async () => {
    const h = await pgPendingWithUnrevokedRefresh("pg-d5-w1");
    let failures = 1;
    const flaky = new Proxy(ledger, { get(target, property) {
      if (property === "endStudioGlobalSignOut") return async (...args: unknown[]) => { if (failures-- > 0) throw new Error("transient ledger error"); return (target.endStudioGlobalSignOut as (...input: unknown[]) => Promise<void>).apply(target, args); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as VoiceLabLedger;
    const a = await pgRecoveryWorker(h, "pg-d5-w1-a", flaky);
    await a.worker.maintainSessions();
    expect(a.driver.globalLogouts).toEqual([h.runId]);
    expect(await pgOutstanding(h.runId)).toHaveLength(1);
    // Ten minutes on the database clock; the owner keeps heartbeating from its own boot: never abandoned.
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '10 minutes' where run_id=$1 and kind='studio.cleanup.global_sign_out_pending'", [h.runId]);
    await pgBootBeat("pg-d5-w1-a", a.worker);
    expect(await ledger.holdsStudioGlobalSignOut(h.runId, (await pgOutstanding(h.runId))[0]!)).toBe(true);
    await a.worker.maintainSessions();
    expect(await pgOutstanding(h.runId)).toEqual([]);
    expect(await pgCleared(h.runId)).toEqual(["confirmed"]);
    expect(await pgTryStart(h, "pg-d5-w1-after")).toBe("accepted");
  }, 120_000);

  it("delta 5 (P3-4) on PostgreSQL: a fresh present vetoes the release only within the bound; past it, with the exchange verified not live, the release records the expired veto", async () => {
    const a = await harness("pg-d5-veto-a");
    await a.worker.runOnce();
    await voice(a, "create");
    const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
    const audio = new AudioResolver(config);
    await audio.initialize();
    const driverB = new ScriptedStudioDriver((await ledger.getRun(a.runId))!);
    let presence: { status: string; reason: string | null } = { status: "present", reason: null };
    let read = 0;
    driverB.recoverResult = (runId) => {
      read += 1;
      return [
        { kind: "studio.cleanup.exchange_ended", source: "canonical", payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true }, dedupeKey: `pg-veto-ended:${runId}` },
        { kind: "studio.room.live_presence", source: "canonical", payload: { schema: "sophia_voice_lab_studio_room_presence_v1", purpose: "recover", status: presence.status, reason: presence.reason, http_status: 200, observation_id: `pg-veto-${read}`, identities_excluded: true }, dedupeKey: `pg-veto:${runId}:${read}` },
        { kind: "studio.cleanup.signed_out", source: "canonical", payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `pg-veto-${read}` }, dedupeKey: `pg-veto-signed-out:${runId}:${read}` },
      ];
    };
    const workerB = new VoiceLabWorker("pg-d5-veto-b", ledger, config, audio, driverB as unknown as VoiceBrowserDriver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await ledger.pool.query("update sophia_voice_lab.browser_leases set expires_at=clock_timestamp()-interval '3 hours' where run_id=$1", [a.runId]);
    await workerB.maintainSessions();
    await workerB.maintainSessions();
    await ledger.pool.query("update sophia_voice_lab.worker_heartbeats set observed_at=clock_timestamp()-interval '10 minutes' where worker_id='pg-d5-veto-a'");
    const age = (by = "2 hours") => ledger.pool.query(`update sophia_voice_lab.run_events set observed_at=observed_at-interval '${by}' where run_id=$1 and kind in ('studio.cleanup.signed_out','studio.cleanup.recovery_attempt')`, [a.runId]);
    await age();
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    // The bridge left the room with the exchange: only unobservable reports now. Within the bound: still held.
    presence = { status: "unobservable", reason: "not_observed" };
    await age();
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).not.toBeNull();
    // Past the bound on the database clock (the present verification 16 minutes old): released, the expired veto audited.
    await ledger.pool.query("update sophia_voice_lab.run_events set observed_at=observed_at-interval '16 minutes' where run_id=$1 and kind='studio.cleanup.dead_owner_verified' and payload->>'room_presence'='present'", [a.runId]);
    await age();
    await workerB.maintainSessions();
    expect(await ledger.getBrowserLease(a.runId)).toBeNull();
    const released = (await ledger.pool.query("select payload from sophia_voice_lab.run_events where run_id=$1 and kind='cleanup.browser_lease_released'", [a.runId])).rows[0].payload;
    expect(released).toMatchObject({ dead_owner_quiesced: true, presence_veto_expired: true, presence_veto_bound_ms: 15 * 60_000, room_presence: "unobservable" });
  }, 120_000);
});
