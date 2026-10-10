import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { VoiceLabConfig } from "../src/config.js";
import type { LabEnvelope } from "../src/domain.js";
import type { VoiceLabLedger } from "../src/ledger.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { VoiceLabWorker } from "../src/worker.js";
import { createWorkerBootIdentity, type WorkerBootIdentity } from "../src/worker-heartbeat.js";
import { EXCHANGE_UUID, studioTestConfig } from "./studio-g7-helpers.js";
import { ScriptedStudioDriver, newIdempotencyKey } from "./studio-g7-worker-helpers.js";

/**
 * Codex P1 (r4233383200): a worker id is stable across process restarts (a
 * platform instance id), so the lease a dead boot left under that id must
 * not be taken for the restarted process's own. The restarted process keeps
 * the id's heartbeat fresh and never sees that browser close: before the fix
 * its cleanup, the lease's compare-and-delete and the admission slot stayed
 * blocked forever. The lease names its owner's boot (write-ahead) and an
 * earlier boot's lease goes through the dead-owner release, gates and all.
 */
const caller: AuthenticatedCaller = { subject: "caller-lease-boot", scopes: new Set(["voice_lab:read", "voice_lab:run"]) };
const START = { environment: "production", scenario_id: "V-G07", scenario_version: "studio-g7-v1" } as const;
/** Literal on purpose: the fail-before run against the earlier sources must not depend on new exports. */
const OWNER_BOOT_KIND = "harness.browser_lease_owner_boot";
const DEAD_OWNER_SCHEMA = "sophia_voice_lab_studio_g7_dead_owner_lease_release_v1";

afterEach(() => { vi.useRealTimers(); });

interface Process { config: VoiceLabConfig; ledger: VoiceLabLedger; service: VoiceLabService; driver: ScriptedStudioDriver; worker: VoiceLabWorker; runId: string }

function workerFor(workerId: string, ledger: VoiceLabLedger, config: VoiceLabConfig, audio: AudioResolver, driver: ScriptedStudioDriver, boot?: WorkerBootIdentity): VoiceLabWorker {
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  return new VoiceLabWorker(workerId, ledger, config, audio, driver as unknown as VoiceBrowserDriver, codec, pino({ level: "silent" }), fetch, undefined, boot);
}

/** A run started by one worker process (its own boot unless `boot` is given). */
async function startedRun(workerId: string, ledger: VoiceLabLedger, boot?: WorkerBootIdentity): Promise<Process> {
  const config = studioTestConfig(undefined, { SOPHIA_VOICE_LAB_MAX_CONCURRENT_RUNS: "1" });
  const audio = new AudioResolver(config);
  await audio.initialize();
  const service = new VoiceLabService(ledger, config, async () => audio.summaries());
  const started = await service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey("lease-boot-start") });
  const run = (await ledger.getRun(started.run_id!))!;
  const driver = new ScriptedStudioDriver(run);
  return { config, ledger, service, driver, worker: workerFor(workerId, ledger, config, audio, driver, boot), runId: run.id };
}

/** Another process for the same run: a fresh driver that retains nothing about it (a new boot unless `boot` is given). */
async function processFor(p: Process, workerId: string, boot?: WorkerBootIdentity): Promise<Process> {
  const audio = new AudioResolver(p.config);
  await audio.initialize();
  const driver = new ScriptedStudioDriver((await p.ledger.getRun(p.runId))!);
  driver.recoverResult = freshRecovery();
  return { ...p, driver, worker: workerFor(workerId, p.ledger, p.config, audio, driver, boot) };
}

async function drive(p: Process, call: Promise<LabEnvelope>): Promise<LabEnvelope> {
  let settled = false;
  const result = call.finally(() => { settled = true; });
  while (!settled) { if (!(await p.worker.runOnce())) await delay(10); }
  return result;
}

const voice = (p: Process, step: string) => drive(p, p.service.studioG7VoiceStep(caller, { run_id: p.runId, step, fixture_id: "a02_short_command", idempotency_key: newIdempotencyKey(`lease-boot-${step}`) }));

/** What a real API-only recovery reports, with a fresh global sign-out per call. */
function freshRecovery() {
  let call = 0;
  return (runId: string) => {
    call += 1;
    return [
      { kind: "studio.cleanup.exchange_ended", source: "canonical" as const, payload: { confirmed: true, status: "confirmed", basis: "run_exchange_not_live", exchange_id: EXCHANGE_UUID, join: "durable", ownership: "not_required", verified_by: "member_snapshot", speak_requested_before_observation: true, call }, dedupeKey: `boot-recovery-ended:${runId}:${call}` },
      { kind: "studio.cleanup.signed_out", source: "canonical" as const, payload: { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted", session_basis: "fresh_grant", sign_out_id: `boot-${runId}-${call}` }, dedupeKey: `boot-recovery-signed-out:${runId}:${call}` },
    ];
  };
}

/** A heartbeat under `workerId`, as the heartbeat loop of the process `of` records it (its attestation names its boot). */
function beat(ledger: VoiceLabLedger, workerId: string, of: { workerBootIdSha256: string }) {
  return ledger.heartbeatWorker({ workerId, serviceVersion: "test", browserReady: true, attestation: { worker_boot_id_sha256: of.workerBootIdSha256 } as never, detail: {}, observedAt: new Date() });
}

const eventsOf = async (ledger: VoiceLabLedger, runId: string) => (await ledger.listEvents(runId, 0, 5_000)).events;
const advance = (ms: number) => { vi.setSystemTime(new Date(Date.now() + ms)); };
const tryStart = (p: Process, key: string) => p.service.startStudioG7Run(caller, { ...START, idempotency_key: newIdempotencyKey(key) }).then((started) => started.status, (error: { detail?: { code?: string } }) => error.detail?.code ?? "error");

describe("Codex P1: a restart under the same stable worker id", () => {
  it("recovers the lease an earlier boot left through the dead-owner release (sign-out after expiry, the JWT lifetime, a fresh verification), then frees the admission slot; the earlier boot can never act on it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const WORKER = "srv-studio-instance-restarts";
    const first = await startedRun(WORKER, ledger);
    await first.worker.runOnce();
    await voice(first, "create");
    const lease = (await ledger.getBrowserLease(first.runId))!;
    expect(lease).toMatchObject({ workerId: WORKER });
    // The process dies. The platform restarts it under the same worker id:
    // a new boot, whose driver retains nothing about the run.
    const second = await processFor(first, WORKER);
    expect(second.worker.workerBootIdSha256).not.toBe(first.worker.workerBootIdSha256);
    // Its heartbeat loop keeps the worker id's heartbeat fresh throughout.
    const pass = async (ms: number) => { advance(ms); await beat(ledger, WORKER, second.worker); await second.worker.maintainSessions(); };
    await pass(40_000);
    await pass(1_000);
    expect(await ledger.getRun(first.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: false });
    // While the earlier boot's access JWTs could still be valid, the lease and the slot stay held.
    await pass(30 * 60_000);
    expect(await ledger.getBrowserLease(first.runId)).not.toBeNull();
    expect(await tryStart(first, "lease-boot-blocked")).not.toBe("accepted");
    // Past the lifetime the lease is released; a run left blocked forever never gets here.
    for (let step = 0; step < 6 && (await ledger.getBrowserLease(first.runId)) !== null; step += 1) await pass(31 * 60_000);
    expect(await ledger.getBrowserLease(first.runId)).toBeNull();
    await pass(1_000);
    expect(await ledger.getRun(first.runId)).toMatchObject({ state: "aborted_driver_restart", cleanupComplete: true });
    expect(await tryStart(first, "lease-boot-after")).toBe("accepted");

    const events = await eventsOf(ledger, first.runId);
    // The earlier boot's lease was never handled as the new boot's own (no close-proof gate on it)...
    expect(events.filter((event) => event.kind === "cleanup.execution_epoch_unconfirmed")).toEqual([]);
    // ...but released through the dead-owner path: a global sign-out after the lease expired,
    // a fresh not-live verification, then a compare-and-delete typed quiesced.
    const pending = events.filter((event) => event.kind === "cleanup.browser_lease_unconfirmed").map((event) => event.payload.dead_owner_release);
    expect(pending).toContain("access_token_lifetime_pending");
    const released = events.filter((event) => event.kind === "cleanup.browser_lease_released");
    expect(released).toHaveLength(1);
    expect(released[0]!.payload).toMatchObject({ schema: DEAD_OWNER_SCHEMA, worker_id_hash: sha256(WORKER), lease_epoch: lease.leaseEpoch, cas_deleted: true, dead_owner_quiesced: true, browser_close: "unobservable_owner_dead", owner_earlier_boot_of_this_worker: true });
    const verified = events.filter((event) => event.kind === "studio.cleanup.dead_owner_verified");
    expect(verified).toHaveLength(1);
    expect(events.some((event) => event.kind === "studio.cleanup.signed_out" && event.payload.scope === "global" && event.at.getTime() > lease.expiresAt.getTime() && event.seq < verified[0]!.seq)).toBe(true);
    expect(second.driver.calls).toContain("recover");

    // Fencing: the earlier boot, were it still running, can never act on that lease again.
    expect(await ledger.heartbeatBrowserLease(first.runId, WORKER, lease.leaseEpoch, 30)).toBe(false);
    await first.worker.maintainSessions();
    expect(await ledger.getBrowserLease(first.runId)).toBeNull();
    expect((await eventsOf(ledger, first.runId)).filter((event) => event.kind === "cleanup.browser_lease_released")).toHaveLength(1);
  }, 60_000);

  it("records the boot that acquires each lease before the lease exists, as hashes only", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const WORKER = "srv-studio-instance-records";
    const p = await startedRun(WORKER, ledger);
    await p.worker.runOnce();
    const events = await eventsOf(ledger, p.runId);
    const records = events.filter((event) => event.kind === OWNER_BOOT_KIND);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ source: "worker", payload: { schema: "sophia_voice_lab_studio_g7_lease_owner_boot_v1", worker_id_sha256: sha256(WORKER), worker_boot_id_sha256: p.worker.workerBootIdSha256, raw_worker_identifier_excluded: true } });
    expect(JSON.stringify(records[0]!.payload)).not.toContain(WORKER);
    // Write-ahead: before the runtime acquired under the lease.
    const runtime = events.find((event) => event.kind === "harness.browser_runtime_acquired");
    expect(runtime && records[0]!.seq < runtime.seq).toBe(true);
  });

  it("on the ledger: a fresh heartbeat from the lease's own boot keeps it; one from a later boot under the same id does not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const WORKER = "srv-studio-instance-ledger";
    const first = await startedRun(WORKER, ledger);
    await first.worker.runOnce();
    await voice(first, "create");
    const second = await processFor(first, WORKER);
    advance(40_000);
    await beat(ledger, WORKER, second.worker);
    await second.worker.maintainSessions();
    advance(1_000);
    await beat(ledger, WORKER, second.worker);
    await second.worker.maintainSessions();
    const proof = { verificationId: randomUUID(), tokenMaxLifetimeMs: 3_600_000, heartbeatStaleMs: 30_000 };
    // The lease's own boot heartbeats: its owner is alive (a hung, not dead, process).
    await beat(ledger, WORKER, first.worker);
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(first.runId, proof)).toEqual({ released: false, reason: "owner_heartbeat_live" });
    // A later boot heartbeats under the same id: the owner's boot is gone, the next gate decides.
    await beat(ledger, WORKER, second.worker);
    expect(await ledger.releaseDeadOwnerStudioBrowserLease(first.runId, proof)).toEqual({ released: false, reason: "access_token_lifetime_pending" });
  }, 60_000);
});

describe("Codex P1 positive controls", () => {
  it("the same boot's lease stays its own: it is heartbeated, and a second worker object of that same boot never takes the dead-owner path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const WORKER = "srv-studio-instance-same-boot";
    const boot = createWorkerBootIdentity(WORKER);
    const p = await startedRun(WORKER, ledger, boot);
    await p.worker.runOnce();
    await voice(p, "create");
    const before = (await ledger.getBrowserLease(p.runId))!;
    advance(5_000);
    await beat(ledger, WORKER, p.worker);
    await p.worker.maintainSessions();
    const renewed = (await ledger.getBrowserLease(p.runId))!;
    expect(renewed).toMatchObject({ workerId: WORKER, leaseEpoch: before.leaseEpoch });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
    // The same boot without the lease in memory (no session either): still its own lease, gated on its own close proof.
    const same = await processFor(p, WORKER, boot);
    expect(same.worker.workerBootIdSha256).toBe(p.worker.workerBootIdSha256);
    for (const ms of [40_000, 1_000, 61 * 60_000, 61 * 60_000]) { advance(ms); await beat(ledger, WORKER, same.worker); await same.worker.maintainSessions(); }
    expect(await ledger.getBrowserLease(p.runId)).not.toBeNull();
    const events = await eventsOf(ledger, p.runId);
    expect(events.some((event) => event.kind === "cleanup.execution_epoch_unconfirmed")).toBe(true);
    expect(events.filter((event) => event.kind === "cleanup.browser_lease_unconfirmed" && event.payload.dead_owner_release !== undefined)).toEqual([]);
    expect(events.some((event) => event.kind === "studio.cleanup.dead_owner_verified" || event.kind === "cleanup.browser_lease_released")).toBe(false);
  }, 60_000);

  it("a different worker's live lease is never stolen while that owner heartbeats from the boot that acquired it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    const ledger = new MemoryVoiceLabLedger("test");
    const owner = await startedRun("srv-studio-instance-alive", ledger);
    await owner.worker.runOnce();
    await voice(owner, "create");
    const other = await processFor(owner, "srv-studio-instance-other");
    // The owner hangs (its lease is no longer renewed) but its process heartbeats, attested by its own boot.
    for (const ms of [40_000, 1_000, 31 * 60_000, 31 * 60_000, 31 * 60_000]) {
      advance(ms);
      await beat(ledger, "srv-studio-instance-alive", owner.worker);
      await beat(ledger, "srv-studio-instance-other", other.worker);
      await other.worker.maintainSessions();
    }
    expect(await ledger.getBrowserLease(owner.runId)).toMatchObject({ workerId: "srv-studio-instance-alive" });
    const events = await eventsOf(ledger, owner.runId);
    expect(events.filter((event) => event.kind === "cleanup.browser_lease_unconfirmed").map((event) => event.payload.dead_owner_release)).toContain("owner_heartbeat_live");
    expect(events.some((event) => event.kind === "cleanup.browser_lease_released")).toBe(false);
  }, 60_000);
});
