import { describe, expect, it } from "vitest";

import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { proveP01LiveBoundary } from "./p01-live-boundary-helper.js";

describe("P01 actual service-boundary integration", () => {
  it("waits for durable evidence after the end operation has already succeeded", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { delayedEvidence: true });
    expect(result.pollingCallCount).toBe(5);
  }, 30_000);
  it("rejects assistant observation polling before the speech operation settles", async () => {
    await expect(proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { assistantBeforeSettlement: true }))
      .rejects.toThrow(/lacked settled speech/);
  }, 30_000);

  it("rejects assistant polling that changes the observation cursor", async () => {
    await expect(proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { delayedAssistant: true, assistantCursorDrift: true }))
      .rejects.toThrow(/exact pending observation/);
  }, 30_000);

  it("counts operation and assistant polls against one owning-speech budget", async () => {
    await expect(proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { assistantTimeoutCount: 9, secondAssistantTimeoutCount: 0 }))
      .rejects.toThrow(/per-operation bound/);
  }, 30_000);

  it("retains both asynchronous assistant waits without advancing the adaptive spine", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { delayedStart: true, delayedAssistant: true });
    expect(result.pollingCallCount).toBe(7);
  }, 30_000);
  it("preserves the ten-poll startup limit before signing", async () => {
    await expect(proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { startTimeoutCount: 11 }))
      .rejects.toThrow(/per-operation bound/);
  }, 30_000);

  it("accepts exactly ten startup timeouts followed by the terminal spine receipt", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { startTimeoutCount: 10 });
    expect(result.pollingCallCount).toBe(14);
  }, 30_000);

  it("retains a bounded startup timeout and certifies only after the exact start settles", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"), { delayedStart: true });
    expect(result.pollingCallCount).toBe(5);
  }, 30_000);

  it("collects real MCP envelopes/audits and attaches the signed claim to the same memory-ledger run", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"));
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollingCallCount).toBe(4);
  }, 30_000);
});
