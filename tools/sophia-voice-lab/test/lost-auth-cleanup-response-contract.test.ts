import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AudioResolver } from "../src/audio.js";
import { DriverEndFailure, type VoiceBrowserDriver } from "../src/browser-driver.js";
import { VoiceLabError, labError, type LabEvent, type RunRecord } from "../src/domain.js";
import { UNCONFIRMED_AUTH_CLEANUP_SCHEMA, authCleanupConfirmed, authCleanupPath, deriveExecutionEpochCleanupProof, preserveAuthCleanupBooleans } from "../src/execution-cleanup.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { CapabilityCodec, redact, sha256 } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { deriveCompletedVerdicts, VoiceLabWorker } from "../src/worker.js";
import { BOOT, EPOCH, PROCESS, auth, closed, event, ownership, provider, recovery } from "./execution-cleanup-fixture.js";
import { caller, testConfig, testRun } from "./helpers.js";

// C059: after exact bound normal finalization and the authenticated provider
// disconnect, a direct auth-cleanup call that does not confirm (its first
// attempt may commit and delete the session a retry would need) is recorded
// unconfirmed; the browser closes; the EXISTING authenticated session:recover
// receipt must prove this run's auth sessions terminal after that close.

type Emitted = Omit<LabEvent, "runId" | "seq" | "at">;
const emitted = (e: LabEvent): Emitted => ({ kind: e.kind, source: e.source, payload: e.payload, dedupeKey: e.dedupeKey });

function finalizedEvent(run: RunRecord, seq = 3): LabEvent {
  const messages = [
    { approximate: false, content: "synthetic request", created_at: "2026-08-23T10:00:00.000Z", final: true, message_id: "message-1", provider_event_id: null, redaction_level: "synthetic", role: "user", sequence: 1, source: "voice", turn_id: "turn-1" },
    { approximate: false, content: "synthetic reply", created_at: "2026-08-23T10:00:01.000Z", final: true, message_id: "message-2", provider_event_id: "provider-2", redaction_level: "synthetic", role: "assistant", sequence: 2, source: "voice", turn_id: "turn-1" },
  ];
  const sorted = (value: unknown): string => Array.isArray(value) ? `[${value.map(sorted).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${sorted(child)}`).join(",")}}` : JSON.stringify(value);
  const finalizedAt = "2026-08-23T10:00:00.000Z";
  const retentionExpiresAt = "2026-08-24T10:00:00.000Z";
  const providerExpiresAt = run.expiresAt.toISOString();
  const transcript = { schema: "sophia_voice_lab_canonical_transcript_v1", source: "sophia_session_messages", synthetic: true, principal_id: run.principalId, test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, environment: run.environment, session_id: run.canonicalSessionId, thread_id: run.threadId, expected_deployment: run.target.expectedDeployment, message_revision: 2, message_count: 2, input_message_count: 1, output_message_count: 1, turn_boundary_count: 1, digest_algorithm: "sha-256", canonicalization: "utf8-json-sort-keys-compact-ascii-v1", sha256: sha256(sorted(messages)), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, raw_audio_excluded: true, messages, turn_boundaries: [{ turn_id: "turn-1", first_sequence: 1, last_sequence: 2, input_message_count: 1, output_message_count: 1 }] };
  return event(run, seq, "session.finalized", "canonical", { http_status: 202, receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), synthetic_isolated: true, finalized_at: finalizedAt, provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, exclusions: { memory: true, offline_pipeline: true, learning: true, ordinary_product_analytics: true, ordinary_user_projects: true, shared_spaces: true, debrief: true }, evidence_receipt: { storage: "supabase", object_path: `voice-lab/${run.testRunId}.json`, sha256: "e".repeat(64) }, canonical_transcript: transcript } });
}

function unconfirmedAttempt(run: RunRecord, seq: number, overrides: Record<string, unknown> = {}): LabEvent {
  return event(run, seq, "auth.session_cleanup", "canonical", {
    cleanup_proof_schema: UNCONFIRMED_AUTH_CLEANUP_SCHEMA, confirmed: false, recovery_required: true,
    status: 403, product_error_code: "voice_lab_authenticated_principal_required",
    voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    process_id_sha256: PROCESS, browser_boot_id_sha256: BOOT, execution_epoch_sha256: EPOCH, ...overrides,
  });
}

function recoveryWithAuth(run: RunRecord, seq: number, authStatus: string, receiptOverrides: Record<string, unknown> = {}): LabEvent {
  const settled = recovery(run, seq);
  const receipt = settled.payload.receipt as Record<string, any>;
  receipt.components.auth_sessions = { status: authStatus, sessions_revoked: 0, grants_tombstoned: 0 };
  if (authStatus === "pending") { receipt.complete = false; receipt.live_cleanup_complete = false; receipt.live_resources_zero = false; settled.payload.complete = false; }
  Object.assign(receipt, receiptOverrides);
  return settled;
}

describe("worker End with an unconfirmed direct auth cleanup after proven normal End", () => {
  type Recovery = "exact" | "pending" | "foreign_run" | "absent";
  async function driveEnd(options: { recovery: Recovery; ownershipProof?: boolean; finalization?: boolean; throwDirect?: boolean; directConfirmed?: boolean }) {
    const ledger = new MemoryVoiceLabLedger("test");
    const config = testConfig();
    const audio = new AudioResolver(config);
    await audio.initialize();
    const run = testRun({ scenarioId: "V-O01", canonicalSessionId: "session-lab-1", threadId: "thread-lab-1", expiresAt: new Date(Date.now() + 600_000) });
    const operation = (type: "start" | "end", idempotencyKey = randomUUID()) => ({ id: randomUUID(), runId: run.id, callerId: run.callerId, type, idempotencyKey, requestHash: sha256(idempotencyKey), input: {} });
    await ledger.createRunWithOperation(run, operation("start"), { global: 1, caller: 1 });
    let present = true;
    const calls: string[] = [];
    const driver = {
      hasSession: () => present,
      start: async () => ({ observedDeployment: run.target.expectedDeployment, events: options.ownershipProof === false ? [] : [emitted(ownership(run)[0]!)] }), // the worker authors runtime acquisition itself
      readiness: async () => ({ ok: true, detail: "fixture", engine: "chromium", version: "fixture" }),
      drain: async () => [],
      end: async () => {
        calls.push("end");
        const done = [...(options.finalization === false ? [] : [finalizedEvent(run)]), provider(run, 4)];
        if (options.throwDirect) throw new DriverEndFailure(new VoiceLabError(labError("AUTH_SESSION_CLEANUP_UNCONFIRMED", "Synthetic", "authorization", true, { status: 403 })), done.map(emitted));
        present = false;
        // The real driver's confirmed receipt: redacted, then the two typed
        // booleans re-authored only after exact validation (C061).
        const directReceipt = event(run, 5, "auth.session_cleanup", "canonical", { ...redact({ ok: true, session_revoked: true, cookies_cleared: true, test_run_id: run.testRunId,
          cleanup_proof_schema: "sophia_voice_lab_execution_epoch_auth_cleanup_v1", voice_lab_run_id_sha256: sha256(run.id), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
          process_id_sha256: PROCESS, browser_boot_id_sha256: BOOT, execution_epoch_sha256: EPOCH }), session_revoked: true, cookies_cleared: true });
        return { events: [...done, options.directConfirmed ? directReceipt : unconfirmedAttempt(run, 5), closed(run, 6)].map(emitted), artifacts: [] };
      },
      abort: async () => { calls.push("abort"); present = false; return { events: [], artifacts: [] }; },
      recover: async () => {
        calls.push("recover");
        if (options.recovery === "absent") return { events: [], artifacts: [] };
        const settled = recoveryWithAuth(run, 7, options.recovery === "pending" ? "pending" : "already_terminal", options.recovery === "foreign_run" ? { test_run_id: "another-run" } : {});
        return { events: [{ ...emitted(settled), dedupeKey: `cleanup:${run.id}:recovery:${calls.length}` }], artifacts: [] };
      },
      cancel: async () => { present = false; },
    } as unknown as VoiceBrowserDriver;
    const worker = new VoiceLabWorker("lost-cleanup-owner", ledger, config, audio, driver,
      new CapabilityCodec(config.capabilitySecret, config.capabilityIssuer, config.capabilityTtlSeconds), pino({ level: "silent" }));
    await worker.runOnce();
    await ledger.createOperation(operation("end", "end-lost-cleanup"));
    await worker.runOnce();
    const end = (await ledger.listOperations(run.id)).find((candidate) => candidate.type === "end")!;
    const service = new VoiceLabService(ledger, config, async () => audio.summaries());
    return { ledger, run, end, calls, service, final: (await ledger.getRun(run.id))! };
  }

  it("completes End when the exact post-close session:recover receipt proves auth terminal", async () => {
    const { ledger, run, end, calls } = await driveEnd({ recovery: "exact" });
    expect(end).toMatchObject({ state: "succeeded" });
    expect(calls.slice(0, 2)).toEqual(["end", "recover"]);
    const events = (await ledger.listEvents(run.id, 0, 200)).events;
    expect(authCleanupPath(run, events)).toBe("recovery");
    // Auth is proven by the recovery path and exposed as such; the run's
    // remaining certification (this minimal fixture carries no audio or
    // transcript evidence) is decided independently of auth.
    const settledRun = (await ledger.getRun(run.id))!;
    expect(settledRun).toMatchObject({ cleanupComplete: true, terminalError: null, verdicts: { auth: "pass" } });
    const evidence = (await ledger.getEvidence(run.id))!;
    const manifest = JSON.parse(Buffer.from((await ledger.getArtifact(evidence.manifestId))!.bytes).toString("utf8"));
    expect(manifest.cleanup_audit).toMatchObject({ auth_session_revoked: true, auth_cleanup_path: "recovery", cleanup_complete: true });
    expect(events.some((e) => e.kind === "auth.session_cleanup" && e.payload.session_revoked === true)).toBe(false); // never a fabricated direct proof
  });

  it.each([
    ["recovery still pending", { recovery: "pending" as const }],
    ["recovery for another run", { recovery: "foreign_run" as const }],
    ["no recovery receipt", { recovery: "absent" as const }],
    ["no process ownership proof", { recovery: "exact" as const, ownershipProof: false }],
    ["no bound finalization receipt", { recovery: "exact" as const, finalization: false }],
  ])("fails End as unconfirmed auth cleanup with %s", async (_label, options) => {
    const { end, final } = await driveEnd(options);
    expect(end).toMatchObject({ state: "failed", error: { code: "AUTH_SESSION_CLEANUP_UNCONFIRMED" } });
    expect(final.state).toBe("authorization_failed");
    expect(final.verdicts.auth).toBe("fail");
  });

  it("proves a normal End through the direct receipt, even while recovery is still pending", async () => {
    const { ledger, run, end, calls } = await driveEnd({ recovery: "pending", directConfirmed: true });
    // No unconfirmed record, so the C059 recovery requirement never engages;
    // the direct epoch proof alone releases the browser lease.
    expect(end).toMatchObject({ state: "succeeded" });
    expect(calls.slice(0, 2)).toEqual(["end", "recover"]);
    const events = (await ledger.listEvents(run.id, 0, 200)).events;
    expect(events.some((e) => e.payload.cleanup_proof_schema === UNCONFIRMED_AUTH_CLEANUP_SCHEMA)).toBe(false);
    expect(deriveExecutionEpochCleanupProof(run, events)).toMatchObject({ ready: true, reason: "direct_cleanup_before_process_death" });
    expect(authCleanupPath(run, events)).toBe("direct");
  });

  it("reports the direct path in evidence once recovery settles live resources", async () => {
    const { ledger, run, end } = await driveEnd({ recovery: "exact", directConfirmed: true });
    expect(end).toMatchObject({ state: "succeeded" });
    const evidence = (await ledger.getEvidence(run.id))!;
    const manifest = JSON.parse(Buffer.from((await ledger.getArtifact(evidence.manifestId))!.bytes).toString("utf8"));
    expect(manifest.cleanup_audit).toMatchObject({ auth_session_revoked: true, auth_cleanup_path: "direct" });
    expect((await ledger.getRun(run.id))!.verdicts.auth).toBe("pass");
  });

  it("keeps a driver-thrown direct failure (pre-proof or D02) unchanged", async () => {
    const { end, final, calls } = await driveEnd({ recovery: "exact", throwDirect: true });
    expect(end).toMatchObject({ state: "failed", error: { code: "AUTH_SESSION_CLEANUP_UNCONFIRMED" } });
    expect(final.state).toBe("authorization_failed");
    expect(calls).toEqual(["end", "abort", "recover"]);
  });

  it("answers a duplicate MCP End through service.endVoiceRun as a read-only terminal replay", async () => {
    const { ledger, run, service, calls, final } = await driveEnd({ recovery: "pending" });
    const before = await ledger.listOperations(run.id);
    for (const key of ["end-lost-cleanup", "end-lost-cleanup-second"]) {
      const replay = await service.endVoiceRun(caller, { run_id: run.id, idempotency_key: key });
      expect(replay.data).toMatchObject({ replay: true, run_state: final.state });
    }
    expect(await ledger.listOperations(run.id)).toEqual(before);
    expect(calls.filter((call) => call === "end")).toHaveLength(1);
  });
});

describe("completed auth verdict: direct receipt or exact recovery-after-close only", () => {
  const run = testRun({ scenarioId: "V-O01" });
  const base = [...ownership(run), provider(run, 3)];
  const cases: Array<[string, LabEvent[], "direct" | "recovery" | null, RunRecord?]> = [
    ["direct receipt", [...base, auth(run, 4), closed(run, 5)], "direct"],
    ["unconfirmed attempt + post-close recovery", [...base, unconfirmedAttempt(run, 4), closed(run, 5), recoveryWithAuth(run, 6, "already_terminal")], "recovery"],
    ["neither", [...base, unconfirmedAttempt(run, 4), closed(run, 5)], null],
    ["recovery without the unconfirmed attempt", [...base, closed(run, 4), recoveryWithAuth(run, 5, "already_terminal")], null],
    ["attempt from another execution epoch", [...base, unconfirmedAttempt(run, 4, { execution_epoch_sha256: "f".repeat(64) }), closed(run, 5), recoveryWithAuth(run, 6, "already_terminal")], null],
    ["attempt from another browser process", [...base, unconfirmedAttempt(run, 4, { process_id_sha256: "a".repeat(64) }), closed(run, 5), recoveryWithAuth(run, 6, "already_terminal")], null],
    ["attempt from another browser boot", [...base, unconfirmedAttempt(run, 4, { browser_boot_id_sha256: "b".repeat(64) }), closed(run, 5), recoveryWithAuth(run, 6, "already_terminal")], null],
    ["attempt after the close", [...base, closed(run, 4), unconfirmedAttempt(run, 5), recoveryWithAuth(run, 6, "already_terminal")], null],
    ["recovery pending", [...base, unconfirmedAttempt(run, 4), closed(run, 5), recoveryWithAuth(run, 6, "pending")], null],
    ["recovery for another run", [...base, unconfirmedAttempt(run, 4), closed(run, 5), recoveryWithAuth(run, 6, "already_terminal", { test_run_id: "another-run" })], null],
  ];
  it.each(cases)("%s", (_label, events, path) => {
    expect(authCleanupPath(run, events)).toBe(path);
    expect(deriveCompletedVerdicts(run, events, []).auth).toBe(path === null ? "fail" : "pass");
  });

  it("does not extend the recovery path to D02", () => {
    const d02 = testRun({ scenarioId: "V-D02" });
    const events = [...ownership(d02), provider(d02, 3), unconfirmedAttempt(d02, 4), closed(d02, 5), recoveryWithAuth(d02, 6, "already_terminal")];
    expect(deriveExecutionEpochCleanupProof(d02, events).ready).toBe(true);
    expect(authCleanupPath(d02, events)).toBeNull();
  });
});

describe("typed auth-cleanup booleans survive durable redaction only when literally authored", () => {
  const redacted = (payload: Record<string, unknown>) => redact(payload) as Record<string, unknown>;
  it("restores the literal pair on a canonical direct receipt and keeps other cookie fields masked", () => {
    const payload = { session_revoked: true, cookies_cleared: true, raw_cookie: "SECRET-cookie-value" };
    const kept = preserveAuthCleanupBooleans({ kind: "auth.session_cleanup", source: "canonical", payload }, redacted(payload));
    expect(kept).toEqual({ session_revoked: true, cookies_cleared: true, raw_cookie: "[REDACTED]" });
    expect(authCleanupConfirmed({ kind: "auth.session_cleanup", payload: kept })).toBe(true);
  });

  it("restores the abort path's confirmed receipt pair only", () => {
    const payload = { confirmed: true, receipt: { session_revoked: true, cookies_cleared: true, raw_cookie: "SECRET" } };
    const kept = preserveAuthCleanupBooleans({ kind: "auth.session_cleanup", source: "canonical", payload }, redacted(payload));
    expect(kept.receipt).toEqual({ session_revoked: true, cookies_cleared: true, raw_cookie: "[REDACTED]" });
  });

  it.each([
    ["a non-canonical source", "browser", { session_revoked: true, cookies_cleared: true }],
    ["a masked string, never true", "canonical", { session_revoked: true, cookies_cleared: "[REDACTED]" }],
    ["a truthy non-boolean", "canonical", { session_revoked: true, cookies_cleared: "true" }],
    ["an unconfirmed abort receipt", "canonical", { confirmed: false, receipt: { session_revoked: true, cookies_cleared: true } }],
    ["an unvalidated abort projection", "canonical", { confirmed: false, receipt: { product_error_code: "voice_lab_authenticated_principal_required" } }],
  ] as const)("does not manufacture the pair for %s", (_label, source, payload) => {
    const event = { kind: "auth.session_cleanup", source, payload: payload as Record<string, unknown> };
    const kept = preserveAuthCleanupBooleans(event, redacted(event.payload));
    expect(authCleanupConfirmed({ kind: event.kind, payload: kept })).toBe(false);
  });
});
