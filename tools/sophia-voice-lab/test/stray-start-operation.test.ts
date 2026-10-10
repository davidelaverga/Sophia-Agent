import { randomUUID } from "node:crypto";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import type { RunRecord } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

/**
 * `claimNextOperation` hands out any queued start in creation order, whatever
 * its run's state (both ledgers). Production never leaves a queued start
 * behind a run that can no longer use it: a run turns terminal only while its
 * own claimed operation executes, or through the worker's terminalization,
 * which first cancels every pending operation of the run (expiry, kill switch,
 * graceful shutdown, recovery after an earlier boot, D02 shutdown). And a
 * start that is claimed anyway for a run past `reserved` is refused before any
 * browser or provider exists. These pin both halves on the worker's real path.
 */
async function harness(run: RunRecord) {
  const ledger = new MemoryVoiceLabLedger("test");
  const config = testConfig();
  const audio = new AudioResolver(config);
  await audio.initialize();
  const start = { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start" as const, idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()), input: {} };
  await ledger.createRunWithOperation(run, start, { global: 1, caller: 1 });
  const calls: string[] = [];
  const driver = {
    hasSession: () => false,
    start: async () => { calls.push("start"); throw new Error("a stray start must never reach the browser driver"); },
    readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
    drain: async () => [],
    end: async () => { calls.push("end"); throw new Error("unexpected end"); },
    abort: async (_run: unknown, code: string) => { calls.push(`abort:${code}`); return { events: [], artifacts: [] }; },
    recover: async () => { calls.push("recover"); return { events: [], artifacts: [] }; },
    cancel: async () => { calls.push("cancel"); },
  } as unknown as VoiceBrowserDriver;
  const worker = new VoiceLabWorker("stray-start-worker", ledger, config, audio, driver,
    new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
  return { ledger, worker, calls, startId: start.id };
}

describe("a stray queued start (production never leaves one claimable, and refuses one claimed late)", () => {
  it("expiry retires a reserved run's queued start before any worker claims it", async () => {
    const h = await harness(testRun({ state: "reserved", createdAt: new Date(Date.now() - 10_000), expiresAt: new Date(Date.now() - 1_000) }));
    await h.worker.maintainSessions();
    const run = (await h.ledger.getRun((await h.ledger.getOperation(h.startId))!.runId))!;
    expect(run.state).toBe("expired");
    expect(await h.ledger.getOperation(h.startId)).toMatchObject({ state: "cancelled", error: { code: "RUN_TERMINATED" } });
    expect(await h.ledger.claimNextOperation("next-worker", 30)).toBeNull();
    expect(h.calls).not.toContain("start");
  });

  it("a start claimed for a run already past reserved is refused before any browser lease or driver start", async () => {
    const h = await harness(testRun({ state: "completed", cleanupComplete: true }));
    await h.worker.runOnce();
    const operation = (await h.ledger.getOperation(h.startId))!;
    expect(operation.state).toBe("failed");
    expect(operation.error).toMatchObject({ code: "BROWSER_SESSION_LOST" });
    expect(await h.ledger.getBrowserLease(operation.runId)).toBeNull();
    expect(h.calls).not.toContain("start");
    expect(await h.ledger.claimNextOperation("next-worker", 30)).toBeNull();
  });
});
