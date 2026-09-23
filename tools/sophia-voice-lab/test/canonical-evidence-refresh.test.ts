import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { AudioResolver } from "../src/audio.js";
import type { VoiceBrowserDriver } from "../src/browser-driver.js";
import { CANONICAL_EVIDENCE_REFRESH_EVENT, canonicalEvidenceRefreshDue } from "../src/canonical-evidence-refresh.js";
import type { LabEvent, RunRecord } from "../src/domain.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, sha256 } from "../src/security.js";
import { VoiceLabWorker, isCanonicalFinalizationReceipt } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

// C077 (J6): a terminal, cleanup-complete run whose canonical_evidence recovery
// component failed on a since-fixed Gateway reader has no supported refresh.

function finalizationPayload(run: RunRecord, finalizedAt: Date) {
  const messages = [
    { approximate: false, content: "synthetic request", created_at: finalizedAt.toISOString(), final: true, message_id: "message-1", provider_event_id: null, redaction_level: "synthetic", role: "user", sequence: 1, source: "voice", turn_id: "turn-1" },
    { approximate: false, content: "synthetic reply", created_at: finalizedAt.toISOString(), final: true, message_id: "message-2", provider_event_id: "provider-2", redaction_level: "synthetic", role: "assistant", sequence: 2, source: "voice", turn_id: "turn-1" },
  ];
  const sorted = (value: unknown): string => Array.isArray(value) ? `[${value.map(sorted).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${sorted(child)}`).join(",")}}` : JSON.stringify(value);
  const retentionExpiresAt = new Date(finalizedAt.getTime() + 24 * 3_600_000).toISOString();
  const providerExpiresAt = run.expiresAt.toISOString();
  const transcript = { schema: "sophia_voice_lab_canonical_transcript_v1", source: "sophia_session_messages", synthetic: true, principal_id: run.principalId, test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, environment: run.environment, session_id: run.canonicalSessionId, thread_id: run.threadId, expected_deployment: run.target.expectedDeployment, message_revision: 2, message_count: 2, input_message_count: 1, output_message_count: 1, turn_boundary_count: 1, digest_algorithm: "sha-256", canonicalization: "utf8-json-sort-keys-compact-ascii-v1", sha256: sha256(sorted(messages)), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, raw_audio_excluded: true, messages, turn_boundaries: [{ turn_id: "turn-1", first_sequence: 1, last_sequence: 2, input_message_count: 1, output_message_count: 1 }] };
  return { receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), synthetic_isolated: true, finalized_at: finalizedAt.toISOString(), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, exclusions: { memory: true, offline_pipeline: true, learning: true, ordinary_product_analytics: true, ordinary_user_projects: true, shared_spaces: true, debrief: true }, evidence_receipt: { storage: "supabase", object_path: `voice-lab/${run.testRunId}.json`, sha256: "e".repeat(64) }, canonical_transcript: transcript } };
}
const builder = { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 };
function recoveryPayload(run: RunRecord, canonical: Record<string, unknown>, retention: { pending: boolean; due: string | null }) {
  return { complete: true, http_status: 200, pending: false, retention_purged: false, retention_purge_pending: retention.pending, retention_purge_due_at: retention.due,
    receipt: { complete: true, live_cleanup_complete: true, live_resources_zero: true, test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      components: { canonical_session: { status: "already_terminal" }, voice_provider: { status: "already_terminal" }, auth_sessions: { status: "already_terminal" }, builder, canonical_evidence: canonical } } };
}

async function j6Like(options: { finalization?: boolean; finalizedAt?: Date } = {}) {
  const ledger = new MemoryVoiceLabLedger("test");
  const run = testRun({ scenarioId: "V-O01", state: "failed_harness", cleanupComplete: true, canonicalSessionId: "session-lab-1", threadId: "thread-lab-1", expiresAt: new Date(Date.now() + 600_000) });
  await ledger.createRunWithOperation(run, { id: randomUUID(), runId: run.id, callerId: run.callerId, type: "start", idempotencyKey: randomUUID(), requestHash: sha256(run.id), input: {} }, { global: 1, caller: 1 });
  const finalizedAt = options.finalizedAt ?? new Date(Date.now() - 3_600_000);
  if (options.finalization !== false) await ledger.appendEvent(run.id, "session.finalized", "canonical", finalizationPayload(run, finalizedAt), `canonical:${run.id}:finalized`);
  await ledger.appendEvent(run.id, "cleanup.recovery", "canonical", recoveryPayload(run, { status: "failed", code: "canonical_evidence_raw_message_set_invalid" }, { pending: false, due: null }), `cleanup:${run.id}:recovery:0`);
  return { ledger, run: (await ledger.getRun(run.id))!, finalizedAt };
}

function worker(ledger: MemoryVoiceLabLedger, recover: (...args: unknown[]) => Promise<unknown>) {
  const config = testConfig({ SOPHIA_VOICE_LAB_KILL_SWITCH: "true" });
  const calls: string[] = [];
  const driver = {
    hasSession: () => false, readiness: async () => ({ ok: true, detail: "fixture" }), close: async () => undefined,
    start: async () => { calls.push("start"); throw new Error("no browser may be allocated"); },
    end: async () => { calls.push("end"); throw new Error("no end"); }, abort: async () => { calls.push("abort"); return { events: [], artifacts: [] }; },
    recover: async (...args: unknown[]) => { calls.push("recover"); return recover(...args); },
  } as unknown as VoiceBrowserDriver;
  return { calls, worker: new VoiceLabWorker("refresh-worker", ledger, config, {} as AudioResolver, driver, new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" })) };
}

describe("canonical evidence refresh (C077)", () => {
  it("re-verifies once with the existing session:recover authority, under the kill switch, and pins the signed deadline", async () => {
    const { ledger, run, finalizedAt } = await j6Like();
    const signed = new Date(finalizedAt.getTime() + 24 * 3_600_000);
    expect((await ledger.listRunsCanonicalEvidenceRefreshDue(new Date(), 10)).map((r) => r.id)).toEqual([run.id]);
    const beforeCursor = run.latestCursor;
    const { worker: w, calls } = worker(ledger, async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical", payload: recoveryPayload(run, { status: "retention_pending", retention_expires_at: signed.toISOString() }, { pending: true, due: signed.toISOString() }), dedupeKey: `cleanup:${run.id}:recovery:refresh` }], artifacts: [] }));
    await w.maintainSessions();
    expect(calls.filter((c) => c !== "recover")).toEqual([]);
    expect(calls.filter((c) => c === "recover").length).toBeGreaterThanOrEqual(1);
    const fresh = (await ledger.getRun(run.id))!;
    expect(fresh).toMatchObject({ retentionPurgePending: true, state: "failed_harness", cleanupComplete: true });
    expect(fresh.retentionPurgeDueAt?.toISOString()).toBe(signed.toISOString());
    const events = (await ledger.listEvents(run.id, 0, 200)).events;
    expect(events.filter((e) => e.kind === CANONICAL_EVIDENCE_REFRESH_EVENT)).toHaveLength(1);
    expect(events.filter((e) => e.kind === "cleanup.recovery")).toHaveLength(2); // the original failed receipt is retained
    expect(fresh.latestCursor).toBeGreaterThan(beforeCursor);
    expect(fresh.verdicts).toEqual(run.verdicts);
    expect(await ledger.listRunsCanonicalEvidenceRefreshDue(new Date(), 10)).toEqual([]);
  });

  it("is bounded: backoff between attempts and at most three, while evidence keeps failing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date());
      const { ledger, run } = await j6Like();
      let n = 0;
      const { worker: w } = worker(ledger, async () => ({ events: [{ kind: "cleanup.recovery", source: "canonical", payload: recoveryPayload(run, { status: "failed", code: "canonical_evidence_raw_message_set_invalid" }, { pending: false, due: null }), dedupeKey: `cleanup:${run.id}:recovery:still-${++n}` }], artifacts: [] }));
      const attempts = async () => (await ledger.listEvents(run.id, 0, 500)).events.filter((e) => e.kind === CANONICAL_EVIDENCE_REFRESH_EVENT).length;
      await w.maintainSessions(); expect(await attempts()).toBe(1);
      await w.maintainSessions(); expect(await attempts()).toBe(1); // backoff
      vi.setSystemTime(new Date(Date.now() + 11 * 60_000)); await w.maintainSessions(); expect(await attempts()).toBe(2);
      vi.setSystemTime(new Date(Date.now() + 21 * 60_000)); await w.maintainSessions(); expect(await attempts()).toBe(3);
      vi.setSystemTime(new Date(Date.now() + 120 * 60_000)); await w.maintainSessions(); expect(await attempts()).toBe(3); // exhausted
      const fresh = (await ledger.getRun(run.id))!;
      expect(fresh.retentionPurgePending).toBe(false); // remote retention stays truthfully unverified
    } finally { vi.useRealTimers(); }
  });

  it.each([
    ["no authenticated finalization receipt", { finalization: false }],
    ["a signed deadline already passed", { finalizedAt: new Date(Date.now() - 25 * 3_600_000) }],
  ])("writes nothing with %s", async (_label, options) => {
    const { ledger, run } = await j6Like(options);
    const before = (await ledger.getRun(run.id))!;
    const { worker: w, calls } = worker(ledger, async () => { throw new Error("must not recover"); });
    await w.maintainSessions();
    expect(calls).toEqual([]);
    const after = (await ledger.getRun(run.id))!;
    expect(after.latestCursor).toBe(before.latestCursor);
    expect(after.retentionPurgeDueAt).toEqual(before.retentionPurgeDueAt);
  });

  it("never selects a run outside the window", () => {
    const run = testRun({ state: "failed_harness", cleanupComplete: true });
    const recovery = (status: string, seq = 2): LabEvent => ({ runId: run.id, seq, kind: "cleanup.recovery", source: "canonical", at: new Date(), dedupeKey: null, payload: { receipt: { components: { canonical_evidence: { status } } } } });
    const now = new Date();
    expect(canonicalEvidenceRefreshDue(run, [recovery("failed")], now)).toMatchObject({ due: true, attempt: 1 });
    expect(canonicalEvidenceRefreshDue(run, [recovery("failed"), recovery("retention_pending", 3)], now)).toMatchObject({ due: false });
    expect(canonicalEvidenceRefreshDue({ ...run, state: "active" }, [recovery("failed")], now)).toMatchObject({ due: false });
    expect(canonicalEvidenceRefreshDue({ ...run, cleanupComplete: false }, [recovery("failed")], now)).toMatchObject({ due: false });
    expect(canonicalEvidenceRefreshDue({ ...run, retentionPurgePending: true }, [recovery("failed")], now)).toMatchObject({ due: false });
    expect(canonicalEvidenceRefreshDue({ ...run, evidencePurgedAt: now }, [recovery("failed")], now)).toMatchObject({ due: false });
    expect(canonicalEvidenceRefreshDue({ ...run, retentionPurgeDueAt: new Date(now.getTime() - 1) }, [recovery("failed")], now)).toMatchObject({ due: false, reason: "local_deadline_reached" });
    const attempt = (seq: number): LabEvent => ({ runId: run.id, seq, kind: CANONICAL_EVIDENCE_REFRESH_EVENT, source: "worker", at: new Date(now.getTime() - 3 * 3_600_000), dedupeKey: null, payload: {} });
    expect(canonicalEvidenceRefreshDue(run, [recovery("failed"), attempt(3), attempt(4), attempt(5)], now)).toMatchObject({ due: false, reason: "attempts_exhausted" });
  });

  it("uses a finalization fixture the canonical validator accepts", async () => {
    const { ledger, run } = await j6Like();
    const finalized = (await ledger.listEvents(run.id, 0, 10)).events.find((e) => e.kind === "session.finalized")!;
    expect(isCanonicalFinalizationReceipt(run, finalized)).toBe(true);
  });
});
