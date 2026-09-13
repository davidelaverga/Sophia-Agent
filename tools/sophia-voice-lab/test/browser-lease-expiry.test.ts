import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { sha256 } from "../src/security.js";
import { testRun } from "./helpers.js";

afterEach(() => vi.useRealTimers());
describe("browser ownership expiry fence", () => {
  it("pages retained expired receipts without erasing or skipping their ownership", async () => {
    const ledger = new MemoryVoiceLabLedger("test");
    const leases = [];
    for (let i = 12; i >= 1; i--) {
      const run = testRun({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` });
      await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 20, caller: 20 });
      leases.push(await ledger.upsertBrowserLease(run.id, "lost-owner", 0));
    }
    const first = await ledger.reapExpiredBrowserLeases(undefined, 10);
    const second = await ledger.reapExpiredBrowserLeases(undefined, 10, first.at(-1)!.runId);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(2);
    expect([...first, ...second]).toEqual([...leases].reverse());
    expect(await ledger.reapExpiredBrowserLeases(undefined, 10, second.at(-1)!.runId)).toEqual([]);
    expect(await ledger.reapExpiredBrowserLeases(undefined, 10)).toEqual(first);
    expect(await ledger.countActiveRuns()).toBe(12);
    for (const limit of [0, -1, 101, 1.5, NaN]) await expect(ledger.reapExpiredBrowserLeases(undefined, limit)).rejects.toThrow(RangeError);
  });
  it.each([-1, 0, 1])("heartbeat at deadline %+i ms cannot resurrect expired ownership", async offset => {
    vi.useFakeTimers();
    const ledger = new MemoryVoiceLabLedger("test");
    const run = testRun();
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    expect((await ledger.getRecoveryControl(run.id))?.browserAllocationEver).toBe(false);
    const lease = await ledger.upsertBrowserLease(run.id, "owner", 60);
    expect((await ledger.getRecoveryControl(run.id))?.browserAllocationEver).toBe(true);
    vi.setSystemTime(new Date(lease.expiresAt.getTime() + offset));
    expect(await ledger.heartbeatBrowserLease(run.id, "foreign", lease.leaseEpoch, 60)).toBe(false);
    expect(await ledger.heartbeatBrowserLease(run.id, "owner", lease.leaseEpoch + 1, 60)).toBe(false);
    expect(await ledger.heartbeatBrowserLease(run.id, "owner", lease.leaseEpoch, 60)).toBe(offset < 0);
    const current = (await ledger.getBrowserLease(run.id))!;
    if (offset >= 0) {
      expect(current).toEqual(lease);
      expect(await ledger.reapExpiredBrowserLeases()).toEqual([lease]);
      // Simulate interruption before any worker loss event can be persisted.
      // The next maintenance pass must still recover the exact same receipt.
      expect(await ledger.getBrowserLease(run.id)).toEqual(lease);
      expect(await ledger.reapExpiredBrowserLeases()).toEqual([lease]);
      expect(await ledger.heartbeatBrowserLease(run.id, "owner", lease.leaseEpoch, 60)).toBe(false);
      expect(await ledger.countActiveRuns()).toBe(1);
      expect((await ledger.getRecoveryControl(run.id))?.browserAllocationEver).toBe(true);
    } else {
      expect(current.expiresAt.getTime()).toBeGreaterThan(lease.expiresAt.getTime());
      expect(await ledger.reapExpiredBrowserLeases()).toEqual([]);
    }
  });
});
