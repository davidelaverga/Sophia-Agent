import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

describe("content-independent recovery inventory keyset", () => {
  it("reaches every unresolved allocation beyond a persistent first page without duplicates", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const expected: string[] = [];
    // Reverse insertion order deliberately differs from durable UUID ordering.
    for (let index = 25; index >= 1; index--) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      const run = testRun({ id, state: "failed_harness", retentionPurgePending: true, retentionPurgeDueAt: new Date(0) });
      await ledger.createRunWithOperation(run, { id: randomUUID(), runId: id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(id), input: {} }, { global: 100, caller: 100 });
      expected.push(id);
    }
    await ledger.purgeExpiredRetention(new Date(), 100);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await ledger.listRecoveryControls(4, cursor);
      if (!page.length) break;
      expect(page.length).toBeLessThanOrEqual(4);
      expect(page.every(control => control.contentPurgedAt !== null)).toBe(true);
      seen.push(...page.map(control => control.binding.runId));
      cursor = page.at(-1)!.binding.runId;
    }
    expect(seen).toEqual(expected.sort());
    expect(new Set(seen).size).toBe(25);
    expect(await ledger.countActiveRuns()).toBe(25);
    // A new scan deliberately wraps; inventory traversal does not settle work.
    expect((await ledger.listRecoveryControls(4))[0]!.binding.runId).toBe(seen[0]);
    expect(await ledger.listRecoveryControls(4, cursor!.toUpperCase())).toEqual([]);
  });

  it.each(["", "not-a-uuid", "00000000-0000-4000-8000-000000000001' OR TRUE", "../run"])("rejects malformed cursor %s before reading work", async cursor => {
    const ledger = new MemoryVoiceLabLedger("test");
    await expect(ledger.listRecoveryControls(10, cursor)).rejects.toThrow();
  });
});
