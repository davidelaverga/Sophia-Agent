import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LabEvent, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { C5_FIRST_USE_ASSESSMENT_SCHEMA, deriveC5FirstUseAssessment, evaluateScenarioAssertions } from "../src/worker.js";
import { auth, closed, ownership, provider, recovery } from "./execution-cleanup-fixture.js";
import { testRun } from "./helpers.js";

// C079: the restricted first-use assessment is reported separately and never
// changes scenario verdicts. It gates on the mission's witnesses only.
const run: RunRecord = testRun({ scenarioId: "V-O01", canonicalSessionId: "session-c5", threadId: "thread-c5", providerEpoch: 1, expiresAt: new Date(Date.now() + 600_000) });
const bound = { app_authenticated: true, synthetic: true, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), principal_id_sha256: sha256(run.principalId), environment: run.environment, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, retention_hours: run.capturePolicy.retentionHours, provider_expires_at: run.expiresAt.toISOString() };
type Draft = Omit<LabEvent, "seq">;
const ev = (kind: string, source: LabEvent["source"], payload: Record<string, unknown>): Draft => ({ runId: run.id, kind, source, payload: source === "product" ? { _product_run_binding: bound, ...payload } : payload, at: new Date(), dedupeKey: null });
const fromFixture = (event: LabEvent): Draft => ({ runId: event.runId, kind: event.kind, source: event.source, payload: event.payload, at: event.at, dedupeKey: null });
const speak = () => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: randomUUID(), requestHash: sha256("x"), input: { text: "hi" }, state: "succeeded", result: { schedule_receipt: { kind: "audio.input.scheduled" } }, attemptCount: 1 }) as any;

function input(operationId: string, transcripts = true): Draft[] {
  const utteranceId = `utterance-${operationId}`, sourceSha = "a".repeat(64), frame = Buffer.from([1, 2, 3, 4]), frameSha = sha256(frame);
  const frameSeq = Buffer.alloc(4); frameSeq.writeUInt32BE(1);
  const chain = sha256(Buffer.concat([Buffer.alloc(32), Buffer.from(frameSha, "hex"), frameSeq]));
  const turn = (source: string, outcome: string) => ev("audio.input.product_turn", "product", { receipt: { schema: "sophia_gemini_input_turn_v1", operation_id: operationId, utterance_id: utteranceId, frame_window_id: `window-${operationId}`, expected_silence: false, raw_audio_excluded: true, source, outcome } });
  return [
    ev("utterance.resolved", "browser", { operation_id: operationId, utterance_id: utteranceId, wav: { sha256: sourceSha } }),
    ev("audio.input.scheduled", "browser", { operation_id: operationId }), ev("audio.input.started", "browser", { operation_id: operationId }),
    ev("harness.input_frame_forwarded", "browser", { operation_id: operationId, utterance_id: utteranceId, frame_seq: 1, byte_length: frame.length, nonzero_byte_count: frame.length, sha256: frameSha }),
    ev("audio.input.completed", "browser", { operation_id: operationId }),
    ev("audio.input.product_leg", "product", { receipt: { schema: "sophia_gemini_input_leg_v1", status: "verified", operation_id: operationId, utterance_id: utteranceId, source_sha256: sourceSha, expected_silence: false, raw_audio_excluded: true, frame_count: 1, sample_count: 2, byte_length: frame.length, pcm_digest_algorithm: "sha-256-chain-v1", pcm_sha256_chain: chain, nonzero_sample_count: 2, pcm_rms: 1, pcm_peak: 1, frame_window_id: `window-${operationId}`, provider_connection_epoch: 1 } }),
    ...(transcripts ? [turn("provider_input_transcription", "provider_input_transcription_observed"), turn("public_user_turn", "public_user_turn_accepted")] : []),
  ];
}
function output(operationId: string, receiveSeq: number, fingerprint: string, drop?: string): Draft[] {
  const at = new Date().toISOString(), realizationId = `gemini-output-1-${receiveSeq}-0-${fingerprint}-1`;
  const join = { providerReceiveSequence: receiveSeq, providerConnectionEpoch: 1, playbackGeneration: 0, relayCorrelationId: `gemini-event-${receiveSeq}`, providerRelaySequence: null, providerReceivedAt: at };
  const common = { ...join, responseId: null, providerEventId: null, chunkIndex: 0, chunksInEvent: 1, chunkHash: fingerprint, byteLength: 3840, realizationId, duplicateOrdinal: 1, providerChunkSequence: `1:${receiveSeq}:0` };
  const events = [ev("audio.output.received", "product", { diagnostic: { ...join, responseId: null, providerEventId: null, chunksInEvent: 1, realizationId } }), ev("audio.output.provider_chunk", "product", { diagnostic: { ...common, scheduled: drop === undefined, dropReason: drop ?? null } })];
  if (drop === undefined) {
    const receipt = { ...common, durationSeconds: 0.25, dropReason: null };
    events.push(ev("audio.output.scheduled", "product", { receipt: { ...receipt, phase: "scheduled" } }), ev("audio.output.started", "product", { receipt: { ...receipt, phase: "started" } }), ev("audio.output.completed", "product", { receipt: { ...receipt, phase: "completed" } }),
      ev("audio.output.leg_receipt", "product", { receipt: { schema: "sophia_gemini_output_leg_v1", status: "verified", completionPhase: "completed", realizationId, providerChunkFingerprint: fingerprint, providerConnectionEpoch: 1, playbackGeneration: 0, monitorDigestSha256: "1".repeat(64), monitorFrameCount: 4, monitorNonSilentFrameCount: 3, rawAudioExcluded: true, scheduledAt: at, completedAt: at, monitorDurationMs: 250 } }));
  }
  events.push(ev("product.voice-session.gemini-synthetic-interaction-receipt", "product", { receipt: { schema: "sophia_gemini_interaction_v1", synthetic: true, test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion,
    interaction_id: `interaction-${operationId}`, operation_id: operationId, response_id: `synthetic-response:1:${receiveSeq}`, assistant_turn_id: `synthetic-response:1:${receiveSeq}`, provider_connection_epoch: 1, phase: "assistant_response_completed", output_realization_ids: [realizationId] } }));
  return events;
}
const accepted = (operationId: string) => ev("operation.speak.accepted", "mcp", { operation_id: operationId });
const deployment = (kind: string) => ev(kind, "canonical", { frontend: { commit_sha: run.target.expectedDeployment.frontend }, backend: { commit_sha: run.target.expectedDeployment.backend }, voice: { commit_sha: run.target.expectedDeployment.voice }, langgraph: { commit_sha: run.target.expectedDependencies.langgraph } });
function finalization(): Draft {
  const finalizedAt = new Date(Date.now() - 3_600_000);
  const messages = [
    { approximate: false, content: "synthetic request", created_at: finalizedAt.toISOString(), final: true, message_id: "message-1", provider_event_id: null, redaction_level: "synthetic", role: "user", sequence: 1, source: "voice", turn_id: "turn-1" },
    { approximate: false, content: "synthetic reply", created_at: finalizedAt.toISOString(), final: true, message_id: "message-2", provider_event_id: "provider-2", redaction_level: "synthetic", role: "assistant", sequence: 2, source: "voice", turn_id: "turn-1" },
  ];
  const sorted = (value: unknown): string => Array.isArray(value) ? `[${value.map(sorted).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${sorted(child)}`).join(",")}}` : JSON.stringify(value);
  const retentionExpiresAt = new Date(finalizedAt.getTime() + 24 * 3_600_000).toISOString(), providerExpiresAt = run.expiresAt.toISOString();
  const transcript = { schema: "sophia_voice_lab_canonical_transcript_v1", source: "sophia_session_messages", synthetic: true, principal_id: run.principalId, test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, environment: run.environment, session_id: run.canonicalSessionId, thread_id: run.threadId, expected_deployment: run.target.expectedDeployment, message_revision: 2, message_count: 2, input_message_count: 1, output_message_count: 1, turn_boundary_count: 1, digest_algorithm: "sha-256", canonicalization: "utf8-json-sort-keys-compact-ascii-v1", sha256: sha256(sorted(messages)), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, raw_audio_excluded: true, messages, turn_boundaries: [{ turn_id: "turn-1", first_sequence: 1, last_sequence: 2, input_message_count: 1, output_message_count: 1 }] };
  return ev("session.finalized", "canonical", { receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), synthetic_isolated: true, finalized_at: finalizedAt.toISOString(), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, exclusions: { memory: true, offline_pipeline: true, learning: true, ordinary_product_analytics: true, ordinary_user_projects: true, shared_spaces: true, debrief: true }, evidence_receipt: { storage: "supabase", object_path: `voice-lab/${run.testRunId}.json`, sha256: "e".repeat(64) }, canonical_transcript: transcript } });
}
function settlement(canonicalEvidence: Record<string, unknown>): Draft[] {
  const [acquired, runtime] = ownership(run);
  const settled = recovery(run);
  (settled.payload.receipt as any).components.canonical_evidence = canonicalEvidence;
  return [...[acquired!, runtime!].map(fromFixture), fromFixture(provider(run)), fromFixture(auth(run)), fromFixture(closed(run)), fromFixture(settled), ev("cleanup.browser_lease_released", "worker", { cas_deleted: true })];
}
const sequence = (drafts: Draft[]): LabEvent[] => drafts.map((draft, index) => ({ ...draft, seq: index + 1 }) as LabEvent);

type EndShape = "succeeded" | "failed" | "timed_out" | "succeeded_without_witness";
const endOperation = (state: string) => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "end", idempotencyKey: randomUUID(), requestHash: sha256("end"), input: {}, state, result: state === "succeeded" ? { run_state: "exporting" } : null, error: state === "succeeded" ? null : { code: "AUTH_SESSION_CLEANUP_UNCONFIRMED" }, attemptCount: 1 }) as any;
function scenario(options: { canonicalEvidence?: Record<string, unknown>; secondBeforeFirstReply?: boolean; secondDropped?: boolean; secondNoTranscript?: boolean; single?: boolean; end?: EndShape } = {}) {
  const first = speak(), second = speak();
  const endShape = options.end ?? "succeeded";
  const end = endOperation(endShape === "succeeded_without_witness" ? "succeeded" : endShape);
  const endWitness = endShape === "succeeded" ? [ev("operation.succeeded", "worker", { operation_id: end.id, operation_type: "end" })]
    : endShape === "succeeded_without_witness" ? [] : [ev("operation.failed", "worker", { operation_id: end.id, operation_type: "end", error: { code: "AUTH_SESSION_CLEANUP_UNCONFIRMED" } })];
  const firstTurn = [accepted(first.id), ...input(first.id), ...output(first.id, 18, "69a61205")];
  const secondTurn = [accepted(second.id), ...input(second.id, !options.secondNoTranscript), ...output(second.id, 107, "c414ce66", options.secondDropped ? "repeated_intent_gate" : undefined)];
  const turns = options.single ? firstTurn : options.secondBeforeFirstReply ? [firstTurn[0]!, secondTurn[0]!, ...firstTurn.slice(1), ...secondTurn.slice(1)] : [...firstTurn, ...secondTurn];
  const events = sequence([deployment("deployment.verified"), ev("harness.initialized", "browser", {}), ev("harness.media_stream_issued", "browser", {}), ev("session.microphone_stream_acquired", "product", {}),
    ...turns, finalization(), deployment("deployment.reverified"), ...settlement(options.canonicalEvidence ?? { status: "retention_pending", retention_expires_at: "2026-09-24T14:20:06.803Z" }), ...endWitness]);
  return { events, operations: [...(options.single ? [first] : [first, second]), end] };
}
const criterion = (result: ReturnType<typeof deriveC5FirstUseAssessment>, id: string) => result.criteria.find((item) => item.id === id)?.status;

describe("C5 first-use assessment (C079)", () => {
  it("reports each mission witness, with ordering-only adaptivity and coordinator review for semantics", () => {
    const { events, operations } = scenario();
    const result = deriveC5FirstUseAssessment(run, events, operations);
    expect(result).toMatchObject({ schema: C5_FIRST_USE_ASSESSMENT_SCHEMA, separate_from_scenario_verdicts: true, semantic_adaptivity: "coordinator_assessment_required" });
    expect(result.not_assessed).toEqual(expect.arrayContaining(["recognition_accuracy", "semantic_adaptivity", "all_chunk_output_certification"]));
    expect(result.utterances.map((u) => u.adaptive_ordering)).toEqual(["not_applicable_first_utterance", "met"]);
    expect(result.utterances.map((u) => [u.input, u.output, u.audible_exact_chain_count])).toEqual([["met", "met", 1], ["met", "met", 1]]);
    expect(result.criteria.filter((item) => item.status !== "met")).toEqual([]);
    expect(result.status).toBe("met");
  });

  it("names the J6 gap: failed canonical evidence", () => {
    const { events, operations } = scenario({ canonicalEvidence: { status: "failed", code: "canonical_evidence_raw_message_set_invalid" } });
    const result = deriveC5FirstUseAssessment(run, events, operations);
    expect(result.status).toBe("gap");
    expect(result.criteria.filter((item) => item.status === "gap").map((item) => item.id)).toEqual(["canonical_evidence_retained"]);
    expect(result.criteria.find((item) => item.id === "canonical_evidence_retained")?.detail).toMatchObject({ canonical_evidence_status: "failed", code: "canonical_evidence_raw_message_set_invalid" });
  });

  it.each([
    ["a second utterance accepted before the first reply completed", { secondBeforeFirstReply: true }, "later_utterances_after_prior_reply"],
    ["a second reply that was only gate-dropped", { secondDropped: true }, "audible_exact_output_each_utterance"],
    ["a second utterance without transcript receipts", { secondNoTranscript: true }, "input_delivery_and_transcript_receipts_each_utterance"],
    ["a single utterance", { single: true }, "two_or_more_non_silent_utterances"],
  ])("reports a gap for %s", (_label, options, id) => {
    const { events, operations } = scenario(options);
    const result = deriveC5FirstUseAssessment(run, events, operations);
    expect(criterion(result, id)).toBe("gap");
    expect(result.status).toBe("gap");
  });

  it.each([
    ["a failed End later settled by recovery", "failed"],
    ["a timed-out End later settled by recovery", "timed_out"],
    ["a succeeded End without its durable completion witness", "succeeded_without_witness"],
  ] as const)("C082: treats %s as an ordinary-End gap", (_label, end) => {
    const { events, operations } = scenario({ end });
    const result = deriveC5FirstUseAssessment(run, events, operations);
    expect(criterion(result, "ordinary_end_and_settlement")).toBe("gap");
    expect(result.status).toBe("gap");
  });

  it("C082: a succeeded ordinary End stays met while the full V-O01 scenario fails (J6 shape)", () => {
    const { events, operations } = scenario();
    const speakOps = operations.filter((operation: any) => operation.type === "speak");
    const withDrop = sequence([...events.map(({ seq: _seq, ...draft }) => draft), ...output(speakOps[1].id, 150, "0bf31dad", "repeated_intent_gate").slice(0, 2)]);
    expect(criterion(deriveC5FirstUseAssessment(run, withDrop, operations), "ordinary_end_and_settlement")).toBe("met");
    expect(evaluateScenarioAssertions(run, withDrop, operations).harness.find((a) => a.id === "o01.provider_chunk_to_playback_to_output_leg_join")?.status).toBe("fail");
  });

  it("stays separate: V-O01 still fails on a gate-dropped chunk while the audible C5 witness is met", () => {
    const { events, operations } = scenario();
    const withDrop = sequence([...events.map(({ seq: _seq, ...draft }) => draft), ...output(operations.filter((operation: any) => operation.type === "speak")[1].id, 150, "0bf31dad", "repeated_intent_gate").slice(0, 2)]);
    expect(criterion(deriveC5FirstUseAssessment(run, withDrop, operations), "audible_exact_output_each_utterance")).toBe("met");
    expect(evaluateScenarioAssertions(run, withDrop, operations).harness.find((a) => a.id === "o01.provider_chunk_to_playback_to_output_leg_join")?.status).toBe("fail");
  });
});
