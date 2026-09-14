import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";
import { ownership, recovery, closed } from "./execution-cleanup-fixture.js";

it("reuses settled product recovery while browser proof is missing and recovers again after new closure evidence", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const run = testRun({ state: "failed_harness", cleanupComplete: false, expiresAt: new Date(Date.now() + 600_000), retentionPurgeDueAt: new Date(Date.now() + 3_600_000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  await ledger.upsertBrowserLease(run.id, "lost-browser-owner", 600);
  for (const event of [...ownership(run), recovery(run)]) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey);
  const recover = vi.fn(async () => ({ events: [{ ...recovery(run), dedupeKey: `recovery:${randomUUID()}` }], artifacts: [] }));
  const driver = { recover, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const makeWorker = () => new VoiceLabWorker(randomUUID(), ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await makeWorker().maintainSessions();
  const first = await ledger.listEvents(run.id, 0, 1000);
  const firstEvidence = await ledger.getEvidence(run.id);
  expect(firstEvidence).not.toBeNull();
  await makeWorker().maintainSessions();
  expect(recover).not.toHaveBeenCalled();
  expect(await ledger.getRun(run.id)).toMatchObject({ cleanupComplete: false });
  expect((await ledger.listEvents(run.id, 0, 1000)).events).toEqual(first.events);
  expect(await ledger.getEvidence(run.id)).toEqual(firstEvidence);
  const close = closed(run);
  await ledger.appendEvent(run.id, close.kind, close.source, close.payload, close.dedupeKey);
  await makeWorker().maintainSessions();
  expect(recover).toHaveBeenCalledTimes(1);
  await makeWorker().maintainSessions();
  expect(recover).toHaveBeenCalledTimes(1);
});

it.each(["unconfirmed", "wrong-binding"])("does not suppress product recovery for a %s receipt", async mode => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const run = testRun({ state: "failed_harness", cleanupComplete: false, expiresAt: new Date(Date.now() + 600_000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const prior = recovery(mode === "wrong-binding" ? testRun() : run);
  if (mode === "unconfirmed") prior.payload.complete = false;
  await ledger.appendEvent(run.id, prior.kind, prior.source, prior.payload, prior.dedupeKey);
  const recover = vi.fn(async () => ({ events: [{ ...recovery(run), dedupeKey: "fresh-recovery" }], artifacts: [] }));
  const driver = { recover, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("replacement", ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await worker.maintainSessions();
  expect(recover).toHaveBeenCalledTimes(1);
});

it("does not consider new suite admission when an expected prior child is missing", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig();
  const child = testRun({ state: "completed", cleanupComplete: true, scenarioId: "V-A01" });
  const suiteId = randomUUID();
  await ledger.createSuite({
    id: suiteId, callerId: child.callerId, idempotencyKey: "missing-suite-child", requestHash: sha256("missing-suite-child"), state: "running",
    scenarioIds: ["V-A01", "V-O01"], runIds: [child.id], nextScenarioIndex: 1,
    definition: { environment: child.environment, target: child.target, capturePolicy: child.capturePolicy,
      scenarios: ["V-A01", "V-O01"].map(id => ({ id: id as "V-A01" | "V-O01", version: child.scenarioVersion, support: "supported" as const, unavailableReason: null })) },
    createdAt: new Date(), updatedAt: new Date(),
  });
  const counts = vi.spyOn(ledger, "countActiveRuns");
  const allocate = vi.spyOn(ledger, "createRunWithOperation");
  const driver = { hasSession: () => false } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("suite-reader", ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await worker.maintainSessions();
  expect(counts).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
  expect(await ledger.getSuite(suiteId)).toMatchObject({ state: "running", runIds: [child.id], nextScenarioIndex: 1 });
  expect(await ledger.getSuiteEvidence(suiteId)).toBeNull();
});

it("bounds expired receipt scans and reaches later pages despite a failed loss write", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const ids: string[] = [];
  for (let i = 1; i <= 12; i++) {
    const run = testRun({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, state: "active", expiresAt: new Date(Date.now() + 600_000) });
    ids.push(run.id);
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 20, caller: 20 });
    await ledger.upsertBrowserLease(run.id, "lost-owner", 0);
  }
  const append = ledger.appendEvent.bind(ledger);
  const observed: string[] = [];
  vi.spyOn(ledger, "appendEvent").mockImplementation(async (...args) => {
    if (args[1] === "durability.browser_worker_loss_observed") {
      observed.push(args[0]);
      if (args[0] === ids[0]) throw new Error("first loss write unavailable");
    }
    return append(...args);
  });
  const driver = { recover: async () => ({ events: [], artifacts: [] }), hasSession: () => false } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("replacement", ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  const reaper = vi.spyOn(ledger, "reapExpiredBrowserLeases");
  await worker.maintainSessions();
  expect(observed).toEqual(ids.slice(0, 10));
  reaper.mockRejectedValueOnce(new Error("page unavailable"));
  await expect(worker.maintainSessions()).rejects.toThrow("page unavailable");
  await worker.maintainSessions();
  expect(observed).toEqual(ids);
  await worker.maintainSessions();
  expect(observed.filter(id => id === ids[0])).toHaveLength(2);
  expect(await ledger.countActiveRuns()).toBe(12);
  for (const id of ids) expect(await ledger.getBrowserLease(id)).not.toBeNull();
  expect(reaper.mock.calls.every(call => call[1] === 10)).toBe(true);
}, 60_000);

it.each(["getRun", "getBrowserLease", "heartbeatBrowserLease"] as const)("isolates active-lease %s failure without losing later expired obligations", async method => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig();
  const audio = new AudioResolver(config);
  await audio.initialize();
  const run = testRun({ scenarioId: "V-A01", expiresAt: new Date(Date.now() + 600_000) });
  const later = testRun({ scenarioId: "V-A01", expiresAt: new Date(Date.now() + 600_000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 2, caller: 2 });
  const continueSession = vi.fn(async (_run: ReturnType<typeof testRun>) => []);
  const driver = {
    hasSession: (id: string) => id === run.id || id === later.id,
    start: async () => ({ observedDeployment: run.target.expectedDeployment, events: [] }),
    readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
    continueSession, drain: async () => [], recover: async () => ({ events: [], artifacts: [] }),
  } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("live-worker", ledger, config, audio, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  expect(await worker.runOnce()).toBe(true);
  expect(await ledger.getRun(run.id)).toMatchObject({ state: "ready" });
  const ownedLease = await ledger.getBrowserLease(run.id);
  await ledger.createRunWithOperation(later, { id: randomUUID(), runId: later.id, callerId: later.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(later.id), input: {} }, { global: 3, caller: 3 });
  expect(await worker.runOnce()).toBe(true);
  expect(await ledger.getRun(later.id)).toMatchObject({ state: "ready" });
  const lost = testRun({ state: "active", expiresAt: new Date(Date.now() + 600_000) });
  await ledger.createRunWithOperation(lost, { id: randomUUID(), runId: lost.id, callerId: lost.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(lost.id), input: {} }, { global: 3, caller: 3 });
  await ledger.upsertBrowserLease(lost.id, "lost-worker", 0);
  const original = ledger[method].bind(ledger);
  let unavailable = true;
  const failure = vi.spyOn(ledger, method).mockImplementation(async (...args: any[]) => {
    if (unavailable && args[0] === run.id) throw new Error("injected active-lease maintenance outage");
    return (original as (...args: any[]) => Promise<any>)(...args);
  });
  const reaper = vi.spyOn(ledger, "reapExpiredBrowserLeases");
  await expect(worker.maintainSessions()).rejects.toThrow("injected active-lease maintenance outage");
  expect(failure).toHaveBeenCalled();
  expect(reaper).toHaveBeenCalledTimes(1);
  expect(continueSession.mock.calls.map(([binding]) => binding.id)).toEqual([later.id]);
  expect((await ledger.listEvents(lost.id, 0, 100)).events).toContainEqual(expect.objectContaining({ kind: "durability.browser_worker_loss_observed" }));
  expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false });
  expect(await ledger.getRecoveryControl(lost.id)).toMatchObject({ liveCleanupComplete: false });
  expect(await ledger.countActiveRuns()).toBe(3);
  unavailable = false;
  expect(await ledger.getBrowserLease(run.id)).toEqual(ownedLease);
  await worker.maintainSessions();
  expect(continueSession.mock.calls.map(([binding]) => binding.id)).toEqual([later.id, run.id, later.id]);
  expect(await ledger.getBrowserLease(run.id)).toMatchObject({ workerId: ownedLease!.workerId, leaseEpoch: ownedLease!.leaseEpoch });
  expect(await ledger.countActiveRuns()).toBe(3);
});

it("continues the expired-lease batch after one loss observation cannot be persisted", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const runs = [testRun({ state: "active" }), testRun({ state: "active" })];
  for (const run of runs) {
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 2, caller: 2 });
    await ledger.upsertBrowserLease(run.id, "lost-worker", 0);
  }
  const leases = await Promise.all(runs.map(run => ledger.getBrowserLease(run.id)));
  const append = ledger.appendEvent.bind(ledger);
  let lossWriteUnavailable = true;
  vi.spyOn(ledger, "appendEvent").mockImplementation(async (...args) => {
    if (lossWriteUnavailable && args[0] === runs[0]!.id && args[1] === "durability.browser_worker_loss_observed") throw new Error("first loss journal unavailable");
    return append(...args);
  });
  const recover = vi.fn(async () => ({ events: [], artifacts: [] }));
  const driver = { recover, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("replacement", ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await expect(worker.maintainSessions()).resolves.toBeUndefined();
  expect((await ledger.listEvents(runs[1]!.id, 0, 100)).events).toContainEqual(expect.objectContaining({ kind: "durability.browser_worker_loss_observed" }));
  expect(await ledger.getRecoveryControl(runs[0]!.id)).toMatchObject({ liveCleanupComplete: false });
  expect(await ledger.getRecoveryControl(runs[1]!.id)).toMatchObject({ liveCleanupComplete: false });
  expect(await ledger.countActiveRuns()).toBe(2);
  expect(await ledger.getBrowserLease(runs[0]!.id)).toEqual(leases[0]);
  lossWriteUnavailable = false;
  const replacement = new VoiceLabWorker("next-replacement", ledger, config, {} as AudioResolver, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await replacement.maintainSessions();
  expect((await ledger.listEvents(runs[0]!.id, 0, 100)).events).toContainEqual(expect.objectContaining({
    kind: "durability.browser_worker_loss_observed", payload: expect.objectContaining({ lost_worker_id_sha256: sha256(leases[0]!.workerId), lost_browser_lease_epoch: leases[0]!.leaseEpoch }),
  }));
  expect(await ledger.countActiveRuns()).toBe(2);
});

it("reaches later recovery pages despite a persistent failure on the first run", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const runs = [];
  for (let i = 0; i < 12; i++) {
    const run = testRun({ id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, state: "completed", cleanupComplete: false, retentionPurgeDueAt: new Date(Date.now() + 3600000) });
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 20, caller: 20 });
    runs.push(run);
  }
  const recover = vi.fn(async (binding: { id: string }) => {
    if (binding.id === runs[0]!.id) throw new Error("synthetic cleanup outage");
    return { events: [{ kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, http_status: 200 } }], artifacts: [] };
  });
  const start = vi.fn();
  const driver = { recover, start, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
  await worker.maintainSessions();
  await worker.maintainSessions();
  expect(new Set(recover.mock.calls.map(([binding]) => binding.id))).toEqual(new Set(runs.map(run => run.id)));
  expect(start).not.toHaveBeenCalled();
  expect(await ledger.countActiveRuns()).toBe(12);
  expect((await ledger.getRecoveryControl(runs[0]!.id))!.liveCleanupComplete).toBe(false);
  await worker.maintainSessions(); // Exhausted cursor wraps to the first page.
  await worker.maintainSessions();
  expect(recover.mock.calls.filter(([binding]) => binding.id === runs[0]!.id)).toHaveLength(2);
});

it("recovers a cached completed run and corrects cleanup before publishing evidence", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const run = testRun({ state: "completed", cleanupComplete: true, retentionPurgeDueAt: new Date(Date.now() + 3600000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const lease = await ledger.upsertBrowserLease(run.id, "lost-worker", 60);
  const recover = vi.fn(async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical" as const, payload: { complete: true, http_status: 200 } }], artifacts: [] }));
  const start = vi.fn();
  const driver = { recover, start, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const codec = new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds);
  const worker = new VoiceLabWorker("replacement-worker", ledger, config, {} as AudioResolver, driver, codec, pino({ level: "silent" }));
  await worker.maintainSessions();
  expect(recover).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  expect(await ledger.getRun(run.id)).toMatchObject({ cleanupComplete: false, verdicts: { evidence: "fail" } });
  expect(await ledger.getRecoveryControl(run.id)).toMatchObject({ liveCleanupComplete: false });
  expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
  expect(await ledger.countActiveRuns()).toBe(1);
  const evidence = (await ledger.getEvidence(run.id))!;
  const artifact = (await ledger.getArtifact(evidence.manifestId))!;
  const manifest = JSON.parse(Buffer.from(artifact.bytes).toString("utf8"));
  expect(manifest.cleanup_audit).toMatchObject({ cleanup_complete: false, live_execution_resources_zero: false, browser_lease_released: false });
  await worker.maintainSessions();
  expect(recover).toHaveBeenCalledTimes(2);
  expect(start).not.toHaveBeenCalled();
  expect(await ledger.getRun(run.id)).toMatchObject({ cleanupComplete: false });
  expect((await ledger.getArtifact(evidence.manifestId))!.bytes).toEqual(artifact.bytes);
  expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
});
