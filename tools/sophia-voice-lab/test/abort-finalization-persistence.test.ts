import { describe, expect, it } from "vitest";
import { collectAbortFinalizationEvents } from "../src/browser-driver.js";
import type { LabEvent } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { testRun } from "./helpers.js";
import { randomUUID } from "node:crypto";
import { sha256 } from "../src/security.js";

describe("abort finalization evidence persistence", () => {
  it.each([false, true])("retains receipt and later cleanup after drain failure; confirmed=%s", async confirmed => {
    const run = testRun();
    const events: Array<Omit<LabEvent, "runId" | "seq" | "at">> = [];
    await collectAbortFinalizationEvents(run.id, events, async () => {
      events.push({ kind: "cleanup.product_finalization", source: "canonical",
        payload: { confirmed, http_status: confirmed ? 202 : 503 }, dedupeKey: `cleanup:${run.id}:product-finalization` });
      throw new Error("capture transport closed after finalization response");
    });
    events.push({ kind: "auth.session_cleanup", source: "canonical", payload: { confirmed: true }, dedupeKey: `cleanup:${run.id}:auth` });
    events.push({ kind: "cleanup.browser_context_closed", source: "browser", payload: { close_resolved: true }, dedupeKey: `cleanup:${run.id}:browser` });
    expect(events.filter(event => event.kind === "cleanup.product_finalization")).toHaveLength(1);
    expect(events[0]!.payload).toEqual({ confirmed, http_status: confirmed ? 202 : 503 });
    expect(events[1]!.kind).toBe("cleanup.post_finalization_observation_unavailable");
    const ledger = new MemoryVoiceLabLedger("test");
    await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId,
      type: "start", idempotencyKey: `start-${run.id}`, requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
    for (const event of events) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey!);
    for (const event of events) await ledger.appendEvent(run.id, event.kind, event.source, event.payload, event.dedupeKey!);
    expect((await ledger.listEvents(run.id, 0, 100)).events).toHaveLength(4);
  });

  it("records unconfirmed finalization when no response was observed", async () => {
    const events: Array<Omit<LabEvent, "runId" | "seq" | "at">> = [];
    await collectAbortFinalizationEvents("run", events, async () => { throw new Error("response unavailable"); });
    expect(events).toEqual([{ kind: "cleanup.product_finalization", source: "canonical",
      payload: { confirmed: false, unavailable_reason: "response unavailable" }, dedupeKey: "cleanup:run:product-finalization" }]);
  });
});
