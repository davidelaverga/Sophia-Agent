import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256 } from "../src/security.js";
import { evaluateScenarioAssertions } from "../src/worker.js";
import { testRun } from "./helpers.js";

// C075: V-O01 output chains keyed on the product's REAL receipt contract (J6):
// 8-hex FNV-1a chunk fingerprints, no provider responseId, and the
// product-authored sophia_gemini_interaction_v1 utterance->output binding.
const run = testRun({ scenarioId: "V-O01" });
const bound = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
let seq = 0;
const product = (kind: string, payload: Record<string, unknown>) => ({ runId: run.id, seq: ++seq, kind, source: "product" as const, payload: { _product_run_binding: bound, ...payload }, at: new Date(), dedupeKey: null });
const speak = (id = randomUUID()) => ({ id, runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: id, requestHash: sha256(id), input: { text: "hello" }, state: "succeeded", result: {}, attemptCount: 1 }) as any;

type Chunk = { receiveSeq: number; fingerprint: string; epoch?: number; ordinal?: number; drop?: string; silent?: boolean };
function chain(c: Chunk) {
  const epoch = c.epoch ?? 1, ordinal = c.ordinal ?? 1, at = new Date().toISOString();
  const realizationId = `gemini-output-${epoch}-${c.receiveSeq}-0-${c.fingerprint}-${ordinal}`;
  const join = { providerReceiveSequence: c.receiveSeq, providerConnectionEpoch: epoch, playbackGeneration: 0, relayCorrelationId: `gemini-event-${c.receiveSeq}`, providerRelaySequence: null, providerReceivedAt: at };
  const common = { ...join, responseId: null, providerEventId: null, chunkIndex: 0, chunksInEvent: 1, chunkHash: c.fingerprint, byteLength: 3840, realizationId, duplicateOrdinal: ordinal, providerChunkSequence: `${epoch}:${c.receiveSeq}:0` };
  const events = [
    product("audio.output.received", { diagnostic: { ...join, responseId: null, providerEventId: null, chunksInEvent: 1, realizationId } }),
    product("audio.output.provider_chunk", { diagnostic: { ...common, scheduled: c.drop === undefined, dropReason: c.drop ?? null } }),
  ];
  if (c.drop === undefined) {
    const receipt = { ...common, durationSeconds: 0.12, dropReason: null };
    events.push(product("audio.output.scheduled", { receipt: { ...receipt, phase: "scheduled" } }),
      product("audio.output.started", { receipt: { ...receipt, phase: "started" } }),
      product("audio.output.completed", { receipt: { ...receipt, phase: "completed" } }),
      product("audio.output.leg_receipt", { receipt: { schema: "sophia_gemini_output_leg_v1", status: c.silent ? "inconclusive" : "verified", completionPhase: "completed", realizationId,
        providerChunkFingerprint: c.fingerprint, providerConnectionEpoch: epoch, playbackGeneration: 0, monitorDigestSha256: "1".repeat(64), monitorFrameCount: 4,
        monitorNonSilentFrameCount: c.silent ? 0 : 3, rawAudioExcluded: true, scheduledAt: at, completedAt: at, monitorDurationMs: 120 } }));
  }
  return { realizationId, events };
}
function interaction(operationId: string, realizations: string[], overrides: Record<string, unknown> = {}) {
  return product("product.voice-session.gemini-synthetic-interaction-receipt", { receipt: { schema: "sophia_gemini_interaction_v1", synthetic: true, test_run_id: run.testRunId,
    scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, interaction_id: `interaction-${operationId}`, operation_id: operationId,
    response_id: "synthetic-response:1:18", assistant_turn_id: "synthetic-response:1:18", provider_connection_epoch: 1, phase: "assistant_response_completed",
    output_realization_ids: realizations, ...overrides } });
}
const verdict = (events: unknown[], operations: unknown[]) => evaluateScenarioAssertions(run, events as any, operations as any).harness.find((a) => a.id === "o01.provider_chunk_to_playback_to_output_leg_join")?.status;

describe("V-O01 native output identity (C075)", () => {
  it("passes the product's real receipt shape: 8-hex fingerprint, null responseId, interaction-bound", () => {
    const op = speak(); const a = chain({ receiveSeq: 18, fingerprint: "69a61205" }), b = chain({ receiveSeq: 19, fingerprint: "e97b44ef" });
    expect(verdict([...a.events, ...b.events, interaction(op.id, [a.realizationId, b.realizationId])], [op])).toBe("pass");
  });

  it("keeps identical-audio repeats distinct by duplicate ordinal, never by the 32-bit fingerprint alone", () => {
    const op = speak(); const a = chain({ receiveSeq: 20, fingerprint: "0bf31dad", ordinal: 1 }), b = chain({ receiveSeq: 21, fingerprint: "0bf31dad", ordinal: 2 });
    expect(verdict([...a.events, ...b.events, interaction(op.id, [a.realizationId, b.realizationId])], [op])).toBe("pass");
  });

  it.each([
    ["no interaction binding at all", (op: any, a: any) => [...a.events]],
    ["a realization claimed by two interactions", (op: any, a: any) => [...a.events, interaction(op.id, [a.realizationId]), interaction("other-op", [a.realizationId], { interaction_id: "interaction-other" })]],
    ["a foreign operation", (op: any, a: any) => [...a.events, interaction("not-this-run-op", [a.realizationId])]],
    ["a cross-epoch binding", (op: any, a: any) => [...a.events, interaction(op.id, [a.realizationId], { provider_connection_epoch: 2 })]],
    ["a missing product response id", (op: any, a: any) => [...a.events, interaction(op.id, [a.realizationId], { response_id: "" })]],
    ["a foreign test run", (op: any, a: any) => [...a.events, interaction(op.id, [a.realizationId], { test_run_id: "another-run" })]],
  ])("rejects %s", (_label, build) => {
    const op = speak(); const a = chain({ receiveSeq: 18, fingerprint: "69a61205" });
    expect(verdict(build(op, a), [op])).toBe("fail");
  });

  it("rejects a composite that does not recompute from its own fields", () => {
    const op = speak(); const a = chain({ receiveSeq: 18, fingerprint: "69a61205" });
    const forged = a.events.map((event) => event.kind === "audio.output.provider_chunk"
      ? { ...event, payload: { ...event.payload, diagnostic: { ...(event.payload as any).diagnostic, duplicateOrdinal: 2 } } } : event);
    expect(verdict([...forged, interaction(op.id, [a.realizationId])], [op])).toBe("fail");
  });

  it("never counts a gate-dropped chunk or a silent leg as audible playback", () => {
    const op = speak(); const good = chain({ receiveSeq: 18, fingerprint: "69a61205" });
    const dropped = chain({ receiveSeq: 19, fingerprint: "e97b44ef", drop: "repeated_intent_gate" });
    const silent = chain({ receiveSeq: 20, fingerprint: "0bf31dad", silent: true });
    expect(verdict([...good.events, ...dropped.events, interaction(op.id, [good.realizationId, dropped.realizationId])], [op])).toBe("fail");
    expect(verdict([...good.events, ...silent.events, interaction(op.id, [good.realizationId, silent.realizationId])], [op])).toBe("fail");
  });

  it("requires an audible chain for EVERY utterance", () => {
    const first = speak(), second = speak(); const a = chain({ receiveSeq: 18, fingerprint: "69a61205" });
    expect(verdict([...a.events, interaction(first.id, [a.realizationId])], [first, second])).toBe("fail");
    const b = chain({ receiveSeq: 107, fingerprint: "c414ce66" });
    expect(verdict([...a.events, ...b.events, interaction(first.id, [a.realizationId]), interaction(second.id, [b.realizationId], { response_id: "synthetic-response:1:107", assistant_turn_id: "synthetic-response:1:107" })], [first, second])).toBe("pass");
  });
});
