import { AsyncLocalStorage } from "node:async_hooks";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActiveLeasePulse, activeLeasePulseIntervalMs, type ActiveLeasePulseOutcome } from "../src/active-lease-pulse.js";
import { RunSerializer } from "../src/run-serializer.js";

/** #151 units: the pulse's schedule and the per-run serialization point. */

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

function recordingPulse(intervalMs = 1_000) {
  const renewals: Array<{ runId: string; epoch: number; at: number }> = [];
  const drains: Array<{ runId: string; epoch: number; at: number }> = [];
  const errors: unknown[] = [];
  let renew: (runId: string, epoch: number) => Promise<ActiveLeasePulseOutcome> = async () => "continue";
  let drain: (runId: string, epoch: number) => Promise<ActiveLeasePulseOutcome> = async () => "continue";
  const pulse = new ActiveLeasePulse(intervalMs, {
    renew: async (runId, epoch) => { renewals.push({ runId, epoch, at: Date.now() }); return renew(runId, epoch); },
    drain: async (runId, epoch) => { drains.push({ runId, epoch, at: Date.now() }); return drain(runId, epoch); },
    onError: (_runId, error) => { errors.push(error); },
  });
  return {
    pulse, renewals, drains, errors,
    onRenew(fn: typeof renew) { renew = fn; },
    onDrain(fn: typeof drain) { drain = fn; },
  };
}

describe("activeLeasePulseIntervalMs", () => {
  it("renews at least three times per lease and at most every 5 s, never faster than 1 s", () => {
    expect(activeLeasePulseIntervalMs(10)).toBe(3_333);
    expect(activeLeasePulseIntervalMs(30)).toBe(5_000);
    expect(activeLeasePulseIntervalMs(120)).toBe(5_000);
    expect(activeLeasePulseIntervalMs(2)).toBe(1_000);
  });
});

describe("ActiveLeasePulse", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does nothing until enabled, then renews and drains on its own chain", async () => {
    const h = recordingPulse(1_000);
    h.pulse.start("run-a", 1);
    expect(h.pulse.pendingTimers).toBe(0);
    h.pulse.enable();
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.renewals.map((call) => call.at)).toEqual([1_000, 2_000, 3_000, 4_000, 5_000].map((offset) => h.renewals[0]!.at - 1_000 + offset));
    expect(h.drains).toHaveLength(5);
    expect(h.renewals.every((call) => call.runId === "run-a" && call.epoch === 1)).toBe(true);
  });

  it("keeps renewing on schedule while a drain hangs, and never overlaps drains of one entry", async () => {
    const h = recordingPulse(1_000);
    const hung = gate();
    let drainsInFlight = 0;
    let maxDrainsInFlight = 0;
    h.onDrain(async () => {
      drainsInFlight += 1;
      maxDrainsInFlight = Math.max(maxDrainsInFlight, drainsInFlight);
      await hung.promise;
      drainsInFlight -= 1;
      return "continue";
    });
    h.pulse.enable();
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.renewals).toHaveLength(10);
    expect(h.drains).toHaveLength(1);
    expect(maxDrainsInFlight).toBe(1);
    hung.open();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.drains).toHaveLength(2);
    h.pulse.stopAll();
    await h.pulse.settle();
  });

  it("never overlaps renewals of one entry: the next tick is armed only after the renewal settled", async () => {
    const h = recordingPulse(1_000);
    const slow = gate();
    h.onRenew(async () => { await slow.promise; return "continue"; });
    h.pulse.enable();
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.renewals).toHaveLength(1);
    expect(h.pulse.pendingTimers).toBe(0);
    slow.open();
    h.onRenew(async () => "continue");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.renewals).toHaveLength(2);
    h.pulse.stopAll();
  });

  it("ends an entry on a renewal or drain outcome of end, with no timer left behind", async () => {
    const h = recordingPulse(1_000);
    h.pulse.enable();
    h.onDrain(async () => "end");
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.pulse.active("run-a", 1)).toBe(false);
    expect(h.pulse.pendingTimers).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.renewals).toHaveLength(1);

    h.onDrain(async () => "continue");
    h.onRenew(async () => "end");
    h.pulse.start("run-b", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.renewals.filter((call) => call.runId === "run-b")).toHaveLength(1);
    expect(h.drains.filter((call) => call.runId === "run-b")).toHaveLength(0);
    expect(h.pulse.pendingTimers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never re-arms after stop(runId), even when the renewal and drain in flight settle afterwards", async () => {
    const h = recordingPulse(1_000);
    const renewal = gate();
    const drainGate = gate();
    h.pulse.enable();
    h.onDrain(async () => { await drainGate.promise; return "continue"; });
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    h.onRenew(async () => { await renewal.promise; return "continue"; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.renewals).toHaveLength(2);
    h.pulse.stop("run-a");
    renewal.open();
    drainGate.open();
    await h.pulse.settle();
    expect(h.pulse.pendingTimers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.renewals).toHaveLength(2);
    expect(h.drains).toHaveLength(1);
  });

  it("an earlier epoch's tick in flight never acts or re-arms after the entry is replaced by a later epoch", async () => {
    const h = recordingPulse(1_000);
    const renewal = gate();
    h.pulse.enable();
    h.onRenew(async (_runId, epoch) => { if (epoch === 1) await renewal.promise; return "continue"; });
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    h.pulse.start("run-a", 2);
    renewal.open();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.renewals.filter((call) => call.epoch === 1)).toHaveLength(1);
    expect(h.drains.filter((call) => call.epoch === 1)).toHaveLength(0);
    expect(h.renewals.filter((call) => call.epoch === 2)).toHaveLength(5);
    expect(h.pulse.active("run-a", 1)).toBe(false);
    expect(h.pulse.active("run-a", 2)).toBe(true);
    expect(h.pulse.pendingTimers).toBe(1);
    h.pulse.stopAll();
  });

  it("stopAll is sticky: clears every timer, refuses later starts and enables, and settle awaits work in flight", async () => {
    const h = recordingPulse(1_000);
    const drainGate = gate();
    h.pulse.enable();
    h.onDrain(async () => { await drainGate.promise; return "continue"; });
    h.pulse.start("run-a", 1);
    h.pulse.start("run-b", 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.pulse.pendingTimers).toBe(2);
    expect(h.pulse.inFlight).toBe(2);
    h.pulse.stopAll();
    expect(h.pulse.pendingTimers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.pulse.enable();
    h.pulse.start("run-c", 1);
    expect(h.pulse.pendingTimers).toBe(0);
    let settled = false;
    const settling = h.pulse.settle().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    drainGate.open();
    await settling;
    expect(h.pulse.inFlight).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.renewals).toHaveLength(2);
    expect(h.drains).toHaveLength(2);
  });

  it("reports a throwing step and keeps the entry alive", async () => {
    const h = recordingPulse(1_000);
    h.pulse.enable();
    h.onRenew(async () => { throw new Error("ledger unavailable"); });
    h.pulse.start("run-a", 1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.errors).toHaveLength(3);
    expect(h.renewals).toHaveLength(3);
    h.pulse.stopAll();
  });

  it("runs every timer in the pulse's own async scope, never in the context that activated the lease", async () => {
    const operationContext = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    const pulse = new ActiveLeasePulse(1_000, {
      renew: async () => { seen.push(operationContext.getStore()); return "continue"; },
      drain: async () => { seen.push(operationContext.getStore()); return "continue"; },
      onError: () => undefined,
    });
    pulse.enable();
    operationContext.run("claimed-operation", () => pulse.start("run-a", 1));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.every((store) => store === undefined)).toBe(true);
    pulse.stopAll();
  });
});

describe("RunSerializer", () => {
  it("gives one run's turns out in order, one at a time, and never couples runs", async () => {
    const serializer = new RunSerializer();
    const order: string[] = [];
    const first = gate();
    const a1 = serializer.run("a", async () => { order.push("a1:start"); await first.promise; order.push("a1:end"); return 1; });
    const a2 = serializer.run("a", async () => { order.push("a2"); return 2; });
    const b1 = serializer.run("b", async () => { order.push("b1"); return 3; });
    await b1;
    expect(order).toEqual(["a1:start", "b1"]);
    expect(serializer.busy("a")).toBe(true);
    expect(serializer.busy("b")).toBe(false);
    first.open();
    expect(await a1).toBe(1);
    expect(await a2).toBe(2);
    expect(order).toEqual(["a1:start", "b1", "a1:end", "a2"]);
    expect(serializer.busy("a")).toBe(false);
  });

  it("tryRun never waits: a held or awaited run is reported busy and its function never runs", async () => {
    const serializer = new RunSerializer();
    const held = gate();
    const holder = serializer.run("a", async () => { await held.promise; });
    let ran = false;
    expect(await serializer.tryRun("a", async () => { ran = true; })).toEqual({ ran: false });
    expect(ran).toBe(false);
    expect(await serializer.tryRun("b", async () => "free")).toEqual({ ran: true, value: "free" });
    held.open();
    await holder;
    expect(await serializer.tryRun("a", async () => "after")).toEqual({ ran: true, value: "after" });
  });

  it("releases the turn when the holder throws", async () => {
    const serializer = new RunSerializer();
    await expect(serializer.run("a", async () => { throw new Error("holder failed"); })).rejects.toThrow("holder failed");
    expect(serializer.busy("a")).toBe(false);
    expect(await serializer.run("a", async () => "next")).toBe("next");
  });
});
