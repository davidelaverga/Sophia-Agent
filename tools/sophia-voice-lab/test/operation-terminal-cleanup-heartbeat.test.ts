import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError, labError } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

it.each([false, true])("does not cancel abort after terminal operation heartbeat; real browser lease loss=%s", async loseBrowserLease => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = { ...testConfig(), operationLeaseSeconds: 3, browserLeaseSeconds: 30, endOperationSeconds: 1 };
  const audio = new AudioResolver(config);
  await audio.initialize();
  const run = testRun({ scenarioId: "V-O01", expiresAt: new Date(Date.now() + 600_000) });
  const operation = (type: "start" | "end") => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input: {} });
  await ledger.createRunWithOperation(run, operation("start"), { global: 1, caller: 1 });
  let browserPresent = true;
  const cancel = vi.fn(async () => { browserPresent = false; });
  let abortEntered!: () => void;
  const entered = new Promise<void>(resolve => { abortEntered = resolve; });
  let finishAbort!: () => void;
  const abortGate = new Promise<void>(resolve => { finishAbort = resolve; });
  const driver = {
    hasSession: () => browserPresent,
    start: async () => ({ observedDeployment: run.target.expectedDeployment, events: [] }),
    readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
    drain: async () => [],
    end: async () => { throw new VoiceLabError(labError("PRODUCT_FINALIZATION_UNCONFIRMED", "Synthetic HTTP409", "product", true)); },
    abort: async () => { abortEntered(); await abortGate; browserPresent = false; return { events: [], artifacts: [] }; },
    recover: async () => ({ events: [], artifacts: [] }), cancel,
  } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("cleanup-owner", ledger, config, audio, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await worker.runOnce();
  expect((await ledger.getRun(run.id))?.state).toBe("ready");
  const end = operation("end");
  await ledger.createOperation(end);
  const browserHeartbeat = vi.spyOn(ledger, "heartbeatBrowserLease");
  const operationHeartbeat = vi.spyOn(ledger, "heartbeatOperation");
  let work: Promise<boolean> | undefined;
  try {
    work = worker.runOnce();
    await entered;
    expect((await ledger.getOperation(end.id))?.state).toBe("failed");
    // The pre-effect fence legitimately renews once before driver.end.
    operationHeartbeat.mockClear();
    browserHeartbeat.mockClear();
    if (loseBrowserLease) browserHeartbeat.mockResolvedValue(false);
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(operationHeartbeat).not.toHaveBeenCalled();
    expect(browserHeartbeat).toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(loseBrowserLease ? 1 : 0);
  } finally {
    finishAbort();
    await work;
  }
});
