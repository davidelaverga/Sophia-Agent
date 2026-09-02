import { describe, expect, it } from "vitest";

import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { proveP01LiveBoundary } from "./p01-live-boundary-helper.js";

describe("P01 actual service-boundary integration", () => {
  it("collects real MCP envelopes/audits and attaches the signed claim to the same memory-ledger run", async () => {
    const result = await proveP01LiveBoundary(new MemoryVoiceLabLedger("test"));
    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.pollingCallCount).toBe(4);
  }, 30_000);
});
