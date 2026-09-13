import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import pino from "pino";
import type { VoiceLabLedger } from "../src/ledger.js";
import { VoiceLabWorker } from "../src/worker.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import type { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { testConfig, testRun } from "./helpers.js";

export async function verifyRestartRecoverySchedule(initial: VoiceLabLedger, reopen?: () => Promise<VoiceLabLedger>, waitForRetry?: () => Promise<void>) {
  let ledger = initial;
  const ids: string[] = [];
  for (let i = 0; i < 13; i++) {
    const run = testRun({ state: "failed_harness", retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
    ids.push(run.id);
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId,
      type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 100, caller: 100 });
  }
  await ledger.purgeExpiredRetention(new Date(), 100);
  const before = await ledger.listRecoveryControls(100);
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const recover = vi.fn(async (_binding: { id: string }) => { throw new Error("synthetic persistent recovery outage"); });
  const start = vi.fn();
  const driver = { recover, start, hasSession: () => false } as unknown as VoiceBrowserDriver;
  const tick = async () => {
    const worker = new VoiceLabWorker(randomUUID(), ledger, config, {} as AudioResolver, driver,
      new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await worker.maintainSessions();
  };
  await tick();
  expect(recover).toHaveBeenCalledTimes(10);
  if (reopen) ledger = await reopen();
  await tick();
  expect(recover).toHaveBeenCalledTimes(13);
  await tick();
  expect(recover).toHaveBeenCalledTimes(13);
  const observed = new Set(recover.mock.calls.map(call => call[0].id));
  expect([...observed].sort()).toEqual(ids.sort());
  expect(await ledger.listRecoveryControls(100)).toEqual(before);
  expect(await ledger.countActiveRuns()).toBe(13);
  expect(start).not.toHaveBeenCalled();
  if (waitForRetry) {
    await waitForRetry();
    await tick();
    expect(recover).toHaveBeenCalledTimes(23);
    expect(await ledger.listRecoveryControls(100)).toEqual(before);
  }
}
