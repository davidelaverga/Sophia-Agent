import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { D02BrowserContextBinding, VoiceBrowserDriver } from "../src/browser-driver.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker, deriveD02BrowserContextBinding } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

describe("V-D02 browser ownership propagation", () => {
  it("derives one deterministic worker/lease-bound context and durably records the driver attestation", async () => {
    const config = testConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const audio = new AudioResolver(config);
    await audio.initialize();
    const run = testRun({ scenarioId: "V-D02" });
    const startOperation = {
      id: randomUUID(),
      runId: run.id,
      callerId: run.callerId,
      type: "start" as const,
      idempotencyKey: `start-${run.id}`,
      requestHash: sha256(run.id),
      input: { environment: run.environment },
    };
    await ledger.createRunWithOperation(run, startOperation, { global: 1, caller: 1 });

    let live = false;
    let observedBinding: D02BrowserContextBinding | undefined;
    const driver = {
      hasSession: () => live,
      start: async (_run, capability, binding) => {
        expect(binding).toBeDefined();
        observedBinding = binding;
        const codec = new CapabilityCodec(config.grantSecret, config.capabilityIssuer, config.capabilityTtlSeconds);
        expect(codec.verify(capability, {
          audience: "sophia-voice-lab-frontend",
          operation: "auth:session",
          principalId: run.principalId,
          testRunId: run.testRunId,
          cleanupObligationId: run.cleanupObligationId,
          environment: run.environment,
          retentionHours: run.capturePolicy.retentionHours,
          providerExpiresAt: run.expiresAt.toISOString(),
          expectedDeployment: run.target.expectedDeployment,
          scenarioId: run.scenarioId,
          scenarioVersion: run.scenarioVersion,
          voiceLabRunIdSha256: binding?.voice_lab_run_id_sha256,
          browserWorkerIdSha256: binding?.browser_worker_id_sha256,
          browserLeaseEpoch: binding?.browser_lease_epoch,
          browserContextIdSha256: binding?.browser_context_id_sha256,
        })).toMatchObject(binding!);
        live = true;
        return { observedDeployment: run.target.expectedDeployment, events: [], browserContextBinding: binding };
      },
      readiness: async () => ({ ok: true, detail: "test", engine: "chromium", version: "test" }),
      cancel: async () => { live = false; },
      close: async () => { live = false; },
    } as unknown as VoiceBrowserDriver;
    const workerId = "browser-worker-d02";
    const worker = new VoiceLabWorker(
      workerId,
      ledger,
      config,
      audio,
      driver,
      new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds),
    );

    expect(await worker.runOnce()).toBe(true);
    const expected = deriveD02BrowserContextBinding(run, workerId, 1);
    expect(observedBinding).toEqual(expected);
    expect(deriveD02BrowserContextBinding(run, workerId, 1)).toEqual(expected);
    expect(deriveD02BrowserContextBinding(run, workerId, 2).browser_context_id_sha256).not.toBe(expected.browser_context_id_sha256);
    expect(deriveD02BrowserContextBinding(run, "other-worker", 1).browser_context_id_sha256).not.toBe(expected.browser_context_id_sha256);

    const events = (await ledger.listEvents(run.id, 0, 500)).events;
    const bindings = events.filter((event) => event.kind === "harness.browser_context_bound");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      source: "canonical",
      payload: {
        schema: "sophia_voice_lab_browser_context_binding_v1",
        test_run_id_sha256: sha256(run.testRunId),
        cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
        ...expected,
        context_allocation: "deterministic_run_worker_lease_v1",
        driver_attested: true,
        raw_run_worker_and_context_identifiers_excluded: true,
      },
    });
    expect(events.find((event) => event.kind === "harness.browser_runtime_acquired")?.payload).toMatchObject({
      worker_id_sha256: expected.browser_worker_id_sha256,
      browser_lease_epoch: expected.browser_lease_epoch,
      browser_context_id_sha256: expected.browser_context_id_sha256,
    });
    expect(await ledger.getRun(run.id)).toMatchObject({ state: "ready" });
  });
});
