import { randomUUID } from "node:crypto";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { AudioResolver } from "../src/audio.js";
import { DriverEndFailure, type VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError, labError } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

it("passes the worker's absolute end-operation deadline, fixed at claim, to the driver", async () => {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig();
  const audio = new AudioResolver(config);
  await audio.initialize();
  const run = testRun({ scenarioId: "V-O01", expiresAt: new Date(Date.now() + 600_000) });
  const operation = (type: "start" | "end") => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input: {} });
  await ledger.createRunWithOperation(run, operation("start"), { global: 1, caller: 1 });
  let present = true;
  const endArgs: unknown[][] = [];
  const driver = {
    hasSession: () => present,
    start: async () => ({ observedDeployment: run.target.expectedDeployment, events: [] }),
    readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
    drain: async () => [],
    end: async (...args: unknown[]) => { endArgs.push([...args, Date.now()]); throw new DriverEndFailure(new VoiceLabError(labError("PRODUCT_FINALIZATION_UNCONFIRMED", "Synthetic", "product", true)), []); },
    abort: async () => { present = false; return { events: [], artifacts: [] }; },
    recover: async () => ({ events: [], artifacts: [] }), cancel: async () => { present = false; },
  } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("deadline-owner", ledger, config, audio, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  await worker.runOnce();
  await ledger.createOperation(operation("end"));
  // Time consumed after the claim and before driver entry (the pre-effect
  // fence heartbeat), as grant minting and fencing consume it in production.
  const heartbeat = ledger.heartbeatOperation.bind(ledger);
  vi.spyOn(ledger, "heartbeatOperation").mockImplementation(async (...args) => { await new Promise(resolve => setTimeout(resolve, 300)); return heartbeat(...args); });
  const claimedAfter = Date.now();
  await worker.runOnce();
  const finishedBy = Date.now();
  expect(endArgs).toHaveLength(1);
  const deadlineAt = endArgs[0]![3] as number;
  // Fixed when the operation was claimed (not at driver entry): within the
  // window between claiming and driver return, plus exactly the end budget.
  expect(deadlineAt).toBeGreaterThanOrEqual(claimedAfter + config.endOperationSeconds * 1_000);
  expect(deadlineAt).toBeLessThanOrEqual(finishedBy + config.endOperationSeconds * 1_000);
  const enteredAt = endArgs[0]![4] as number;
  expect(enteredAt - claimedAfter).toBeGreaterThanOrEqual(280);
  // Not a fresh window from driver entry: the pre-entry time stays consumed.
  expect(deadlineAt).toBeLessThanOrEqual(enteredAt + config.endOperationSeconds * 1_000 - 250);
});
