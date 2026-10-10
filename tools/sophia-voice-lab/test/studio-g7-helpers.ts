import { randomUUID } from "node:crypto";

import type { VoiceLabConfig } from "../src/config.js";
import type { LabEvent, OperationRecord, RunRecord } from "../src/domain.js";
import { sha256 } from "../src/security.js";
import { studioTargetSpec } from "../src/service.js";
import { STUDIO_PAGE_RECEIPT_SCHEMA, canonicalJson, computeRunBindingSha256 } from "../src/studio-g7/contract.js";
import { testConfig, testRun } from "./helpers.js";

export const STUDIO_SHA = "1".repeat(40);
export const API_SHA = "2".repeat(40);
export const BRIDGE_SHA = "3".repeat(40);
export const PRINCIPAL_UUID = "7c1e1a52-9a8b-4c5d-8e6f-0123456789ab";
export const PROJECT_UUID = "5d0c3f8e-1b2a-4c3d-9e8f-a1b2c3d4e5f6";
export const GRANT_UUID = "0f9e8d7c-6b5a-4c3d-8e2f-1a2b3c4d5e6f";
export const EXCHANGE_UUID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const PROVIDER_SESSION_UUID = "4b3a2c1d-0e9f-4a8b-9c7d-6e5f4a3b2c1d";
/** Obviously fake test credentials. */
export const FAKE_EMAIL = "voice-lab-synthetic@example.test";
export const FAKE_PASSWORD = "fake-password-not-a-secret-0001";
export const FAKE_PUBLISHABLE_KEY = "fake-publishable-key-000000000000";
export const FAKE_ACCESS_TOKEN = "fake-access-token-not-a-real-jwt-0001";
export const FAKE_REFRESH_TOKEN = "fake-refresh-token-0001";

export interface StudioOrigins { studio: string; api: string; supabase: string }

export const DEFAULT_ORIGINS: StudioOrigins = { studio: "http://studio.test", api: "http://api.test", supabase: "http://abc.supabase.test" };

export function studioTestConfig(origins: StudioOrigins = DEFAULT_ORIGINS, overrides: NodeJS.ProcessEnv = {}): VoiceLabConfig {
  return testConfig({
    SOPHIA_VOICE_LAB_ALLOWED_ORIGINS: `http://frontend.test,http://gateway.test,http://voice.test,http://langgraph.test,${origins.studio},${origins.api},${origins.supabase}`,
    SOPHIA_VOICE_LAB_PRINCIPAL_ID: PRINCIPAL_UUID,
    SOPHIA_VOICE_LAB_TARGET_KIND: "studio-livekit-g7-v1",
    SOPHIA_VOICE_LAB_STUDIO_ORIGIN: origins.studio,
    SOPHIA_VOICE_LAB_STUDIO_API_ORIGIN: origins.api,
    SOPHIA_VOICE_LAB_STUDIO_SUPABASE_URL: origins.supabase,
    SOPHIA_VOICE_LAB_STUDIO_SUPABASE_PUBLISHABLE_KEY: FAKE_PUBLISHABLE_KEY,
    SOPHIA_VOICE_LAB_STUDIO_PROJECT_ID: PROJECT_UUID,
    SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_EMAIL: FAKE_EMAIL,
    SOPHIA_VOICE_LAB_STUDIO_PRINCIPAL_PASSWORD: FAKE_PASSWORD,
    SOPHIA_VOICE_LAB_STUDIO_EXPECTED_STUDIO_SHA: STUDIO_SHA,
    SOPHIA_VOICE_LAB_STUDIO_EXPECTED_API_SHA: API_SHA,
    SOPHIA_VOICE_LAB_STUDIO_EXPECTED_BRIDGE_SHA: BRIDGE_SHA,
    SOPHIA_VOICE_LAB_STUDIO_GRANT_WAIT_SECONDS: "10",
    SOPHIA_VOICE_LAB_STUDIO_GRANT_REJOIN_SECONDS: "5",
    ...overrides,
  });
}

export function studioRun(config: VoiceLabConfig, patch: Partial<RunRecord> = {}): RunRecord {
  return testRun({
    principalId: PRINCIPAL_UUID,
    scenarioId: "V-G07",
    scenarioVersion: "studio-g7-v1",
    target: studioTargetSpec(config.studioG7!),
    capturePolicy: { rawAudio: false, screenshot: false, video: false, retentionHours: 24 },
    expiresAt: new Date(Date.now() + 600_000),
    ...patch,
  });
}

export function bindingOf(run: RunRecord): string {
  return computeRunBindingSha256({ testRunId: run.testRunId, cleanupObligationId: run.cleanupObligationId, scenarioId: run.scenarioId!, scenarioVersion: run.scenarioVersion! });
}

/** Builds an append-only event list with ledger-like sequence numbers. */
export class EventLog {
  readonly events: LabEvent[] = [];
  constructor(readonly runId: string) {}
  add(kind: string, source: LabEvent["source"], payload: Record<string, unknown>): LabEvent {
    const event: LabEvent = { runId: this.runId, seq: this.events.length + 1, kind, source, at: new Date(), payload, dedupeKey: null };
    this.events.push(event);
    return event;
  }
  page(receipt: Record<string, unknown>): LabEvent {
    const json = canonicalJson(receipt);
    return this.add("studio.page_receipt", "product", { event: receipt.event, receipt_json: json, receipt_sha256: sha256(json) });
  }
  bridge(kind: string, receipt: Record<string, unknown>, source = kind === "guard" ? "service" : "bridge", seq: unknown = receipt.seq ?? 0): LabEvent {
    const json = canonicalJson(receipt);
    return this.add("studio.bridge_receipt", "canonical", { exchange_id: EXCHANGE_UUID, source, seq, kind, received_at: new Date().toISOString(), receipt_json: json, receipt_sha256: sha256(json) });
  }
  grant(grant: Record<string, unknown>, exchangeState = "open"): LabEvent {
    const json = canonicalJson(grant);
    return this.add("studio.bridge_grant", "canonical", { exchange_id: EXCHANGE_UUID, exchange_state: exchangeState, grant_json: json, grant_sha256: sha256(json) });
  }
}

export const LAB_TRACK_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
export const TRACK_SID = "TR_AMkxyz0123";
export const SOPHIA_TRACK_SID = "TR_SOPHIA0123";

export function pageReceipt(run: RunRecord, event: "mic_published" | "mic_unpublished" | "sophia_playback", atMs: number, extra: Record<string, unknown> = {}, binding = bindingOf(run), grantId = GRANT_UUID): Record<string, unknown> {
  return {
    schema: STUDIO_PAGE_RECEIPT_SCHEMA, grantId, runBindingSha256: binding, atMs, event,
    ...(event === "mic_published" ? { trackSid: TRACK_SID, trackId: LAB_TRACK_ID } : event === "mic_unpublished" ? { trackSid: TRACK_SID } : { phase: "playing", trackSid: SOPHIA_TRACK_SID, mediaTimeMs: 0 }),
    ...extra,
  };
}

/** Migration 0046 bridge body: its own kind, the optional bridge schema label, the grant binding. */
export function bridgeBase(run: RunRecord, kind: string, seq: number, atMs: number, binding = bindingOf(run), grantId = GRANT_UUID): Record<string, unknown> {
  return { kind, schema: `sophia.bridge.${kind}.v1`, grantId, runBindingSha256: binding, seq, atMs };
}

/** The guard's own receipt, as `sophia.voice_qualification_guard()` writes it (service seq 0, no body seq). */
export function guardReceipt(run: RunRecord, reason: string, atMs = 2_000, binding = bindingOf(run), grantId = GRANT_UUID): Record<string, unknown> {
  return { kind: "guard", schema: "sophia.service.guard.v1", grantId, runBindingSha256: binding, reason, atMs };
}

export function inputWindow(run: RunRecord, seq: number, windowSeq: number, durationMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const samples = Math.round(durationMs * 16 * 1.25);
  return {
    ...bridgeBase(run, "input_window", seq, 1_000 + seq),
    windowSeq, inputEpoch: 1, providerSession: PROVIDER_SESSION_UUID, connection: 1,
    startedAtMs: 10_000 * windowSeq, endedAtMs: 10_000 * windowSeq + Math.round(durationMs * 1.25), endReason: "turn_complete",
    chunkCount: 50, sampleCount: samples, nonzeroSampleCount: Math.round(samples * 0.7), audibleChunkCount: 30,
    rms: 0.12, peak: 0.6, droppedSamples: 0, sampleRate: 16_000, pcmDigestAlgorithm: "sha-256-chain-v1",
    pcmSha256Chain: sha256(`bridge-chain-${windowSeq}`), rawAudioExcluded: true,
    ...overrides,
  };
}

export function inputTurn(run: RunRecord, seq: number, windowSeq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bridgeBase(run, "input_turn", seq, 1_000 + seq), windowSeq, turnOrdinal: windowSeq, inputTranscriptionObserved: true, transcriptChars: 42, finished: true, attributedToHolder: true, modelResponded: true, toolCallCount: 0, outcome: "answered", ...overrides };
}

export function providerReceipt(run: RunRecord, seq: number, phase: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bridgeBase(run, "provider", seq, 1_000 + seq), phase, providerSession: PROVIDER_SESSION_UUID, connection: 1, resumed: false, model: "models/gemini-live-2.5-flash", instructionSha256: sha256("instructions"), bridgeCommit: BRIDGE_SHA, usageTokens: phase === "usage" ? 1_234 : null, ...overrides };
}

export function outputReply(run: RunRecord, seq: number, replyOrdinal: number, firstPlayedAtMs: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bridgeBase(run, "output_reply", seq, 1_000 + seq), replyOrdinal, turnOrdinal: replyOrdinal, providerSession: PROVIDER_SESSION_UUID, connection: 1, receivedAtMs: firstPlayedAtMs - 100, firstPlayedAtMs, endedAtMs: firstPlayedAtMs + 2_000, terminal: "played", samplesReceived: 48_000, framesPlayed: 100, nonSilentFramesPlayed: 80, rms: 0.1, peak: 0.5, durationMs: 2_000, playedDigestAlgorithm: "sha-256-chain-v1", playedSha256Chain: sha256(`played-${replyOrdinal}`), ...overrides };
}

export function sessionClosed(run: RunRecord, seq: number, counts: { windows: number; turns: number; replies: number }, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...bridgeBase(run, "session_closed", seq, 1_000 + seq), providerClosed: true, windows: counts.windows, turns: counts.turns, replies: counts.replies, toolCalls: 0, typedMessages: 0, transcriptRetained: false, reason: "ended", ...overrides };
}

/** The `grant` object of `voice_qualification_evidence_read` (0046). */
export function evidenceGrant(run: RunRecord, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    grantId: GRANT_UUID, runBindingSha256: bindingOf(run), deadline: new Date(Date.now() + 600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), revokedAt: null,
    maxExchangeSeconds: 600, maxProviderConnections: 3, maxTurns: 20, maxOutputTokensPerTurn: 1_000, maxUsageTokens: 200_000,
    connectionsOpened: 1, turns: 2, usageTokens: 1_234, lastPromptTokens: 600, endedReason: null, ...overrides,
  };
}

/** The whole evidence answer (0046), receipts ordered by source then seq. */
export function evidenceEnvelope(run: RunRecord, receipts: Array<[string, Record<string, unknown>]>, overrides: { state?: string; grant?: Record<string, unknown>; exchangeId?: string } = {}): Record<string, unknown> {
  const rows = receipts.map(([kind, receipt]) => ({ source: kind === "guard" ? "service" : "bridge", seq: kind === "guard" ? 0 : Number(receipt.seq), kind, receivedAt: new Date(1_791_500_000_000 + Number(receipt.seq ?? 0)).toISOString(), receipt }));
  rows.sort((left, right) => left.source === right.source ? left.seq - right.seq : left.source < right.source ? -1 : 1);
  return { exchangeId: overrides.exchangeId ?? EXCHANGE_UUID, state: overrides.state ?? "open", grant: overrides.grant ?? evidenceGrant(run), receipts: rows };
}

export function speakOperation(run: RunRecord, createdAt: Date, overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", state: "succeeded", idempotencyKey: randomUUID(), requestHash: sha256(randomUUID()),
    input: { fixture_id: "conversation_greeting_probe" }, result: { schedule_receipt: { product: {} } }, error: null, leaseOwner: null, leaseEpoch: 1, leaseExpiresAt: null,
    attemptCount: 1, createdAt, updatedAt: createdAt, ...overrides,
  };
}

/** Lab-side scheduling chain for one utterance (page clock in observed_at). */
export function labUtterance(log: EventLog, operationId: string, startMs: number, durationMs: number): void {
  const provenance = (at: number) => ({ _capture_provenance: { source: "voice-lab-init", observed_at: new Date(at).toISOString() } });
  log.add("utterance.resolved", "worker", { operation_id: operationId, utterance_id: randomUUID(), wav: { sha256: sha256(operationId), duration_ms: durationMs } });
  log.add("audio.input.scheduled", "browser", { operation_id: operationId, ...provenance(startMs - 10) });
  log.add("audio.input.started", "browser", { operation_id: operationId, ...provenance(startMs) });
  log.add("audio.input.completed", "browser", { operation_id: operationId, ...provenance(startMs + durationMs) });
}

/** Cleanup proofs the Studio driver and worker author on a normal end. */
/** End's cleanup; `beforeSignOut` runs after the exchange is confirmed ended and before the global sign-out (End's post-quiescence calls audit). */
export function cleanupEvents(log: EventLog, beforeSignOut: () => void = () => undefined): void {
  log.add("studio.cleanup.exchange_ended", "canonical", { confirmed: true, status: "confirmed", basis: "api_end", exchange_id: EXCHANGE_UUID, join: "retained", ownership: "proven", verified_by: "member_snapshot", speak_requested_before_observation: true });
  beforeSignOut();
  log.add("studio.cleanup.signed_out", "canonical", { schema: "sophia_voice_lab_studio_sign_out_v1", scope: "global", confirmed: true, http_status: 204, basis: "global_logout_accepted" });
  log.add("cleanup.browser_context_closed", "browser", { close_resolved: true, browser_registry_absent: true, browser_process_close_resolved: true });
  log.add("cleanup.browser_lease_released", "worker", { cas_deleted: true });
}

export function identityEvent(log: EventLog, phase: string, api: Record<string, unknown> = { status: "observed", commit: API_SHA }, studio: Record<string, unknown> = { status: "observed", commit: STUDIO_SHA }): void {
  log.add("studio.deployment.identity", "canonical", { phase, api, studio });
}
