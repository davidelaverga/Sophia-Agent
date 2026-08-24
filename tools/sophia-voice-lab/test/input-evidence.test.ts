import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BUNDLED_FIXTURE_MANIFEST_SHA256 } from "../src/config.js";
import { initialVerdicts, type LabEvent, type OperationRecord } from "../src/domain.js";
import { canonicalRequestHash, sha256 } from "../src/security.js";
import { S01_FRONTEND_GRANT_VARIANTS, S01_OAUTH_VARIANTS, S02_HTTP_VARIANTS, S02_MCP_BOUNDARY_PROBE_SCHEMA, S02_VALIDATION_VARIANTS, deriveCompletedVerdicts, isCanonicalFinalizationReceipt, isExactS02McpBoundaryProbe, reconcileProductInputLeg, s02HttpProbeExpectation } from "../src/worker.js";
import { testRun } from "./helpers.js";

function operation(fixtureId = "a02_short_command"): OperationRecord {
  const now = new Date();
  return { id: randomUUID(), runId: randomUUID(), callerId: "caller-1", type: "speak", state: "succeeded", idempotencyKey: "input-proof-key", requestHash: "a".repeat(64), input: { fixture_id: fixtureId }, result: { schedule_receipt: { kind: "audio.input.scheduled" } }, error: null, leaseOwner: null, leaseEpoch: 1, leaseExpiresAt: null, attemptCount: 1, createdAt: now, updatedAt: now };
}

function frame(runId: string, operationId: string, seq: number, bytes: Buffer): LabEvent {
  return { runId, seq, kind: "harness.input_frame_forwarded", source: "browser", at: new Date(), payload: { operation_id: operationId, utterance_id: "utt-1", frame_seq: seq, byte_length: bytes.length, nonzero_byte_count: [...bytes].filter((value) => value !== 0).length, sha256: sha256(bytes) }, dedupeKey: `frame:${seq}` };
}

function chain(frames: Buffer[]): string {
  let current = Buffer.alloc(32);
  frames.forEach((bytes, index) => {
    const sequence = Buffer.alloc(4); sequence.writeUInt32BE(index + 1);
    current = Buffer.from(sha256(Buffer.concat([current, Buffer.from(sha256(bytes), "hex"), sequence])), "hex");
  });
  return current.toString("hex");
}

function s02Boundary(runId: string, seq: number, variant: typeof S02_HTTP_VARIANTS[number]): LabEvent {
  const expectation = s02HttpProbeExpectation(variant);
  const startedAt = new Date(Date.UTC(2026, 7, 23, 12, 0, 0, seq * 10));
  const auditAt = new Date(startedAt.getTime() + 2);
  const responseAt = new Date(startedAt.getTime() + 4);
  const eventAt = new Date(startedAt.getTime() + 6);
  const probeIdHash = sha256(`s02-probe:${variant}`);
  const rawBodyHash = sha256(`s02-request-body:${variant}`);
  const canonicalBodyHash = expectation.auditUsesBoundedFallback ? sha256("bounded-unparsed-request") : sha256(`s02-canonical-body:${variant}`);
  const snapshot = { active_run_count: 1, operation_count: 1, run_event_cursor: seq - 1, input_mutation_event_count: 0, browser_context_count: 0, canonical_session_count: 0, provider_session_count: 0 };
  return {
    runId,
    seq,
    kind: "security.mcp_boundary_probe",
    source: "canonical",
    at: eventAt,
    payload: {
      schema: S02_MCP_BOUNDARY_PROBE_SCHEMA,
      variant,
      probe_id_sha256: probeIdHash,
      request: {
        contract: expectation.requestContract,
        contract_sha256: canonicalRequestHash(expectation.requestContract),
        endpoint_origin_sha256: sha256("https://voice-lab.example"),
        raw_body_sha256: rawBodyHash,
        canonical_body_sha256: canonicalBodyHash,
        byte_length: variant === "oversized_json" ? 150_001 : 512,
        started_at: startedAt.toISOString(),
      },
      response: {
        http_status: expectation.httpStatus,
        error_code: expectation.errorCode,
        body_sha256: sha256(`s02-response-body:${variant}`),
        byte_length: 512,
        content_type: expectation.httpStatus === 200 ? "text/event-stream" : "application/json",
        final_origin_sha256: sha256("https://voice-lab.example"),
        final_path: "/mcp",
        location: null,
        observed_at: responseAt.toISOString(),
      },
      audit_receipts: [{
        action: expectation.auditAction,
        outcome: expectation.auditOutcome,
        argument_sha256: canonicalBodyHash,
        caller_partition_id: `cp1:test:${sha256("caller-partition")}`,
        probe_id_sha256: probeIdHash,
        request_id_sha256: sha256(`s02-server-request:${variant}`),
        error_class: expectation.auditErrorClass,
        observed_at: auditAt.toISOString(),
      }],
      resource_delta: { before: snapshot, after: { ...snapshot } },
    },
    dedupeKey: `security:${runId}:mcp-boundary:${variant}`,
  };
}

describe("exact input-leg evidence", () => {
  it("recomputes the product SHA-256 PCM chain from ordered ordinary WebSocket frame receipts", () => {
    const op = operation();
    const frames = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])];
    const events = frames.map((bytes, index) => frame(op.runId, op.id, index + 1, bytes));
    const leg = { frame_count: 2, byte_length: 8, pcm_digest_algorithm: "sha-256-chain-v1", pcm_sha256_chain: chain(frames), nonzero_sample_count: 4 };
    expect(reconcileProductInputLeg(events, op, leg)).toMatchObject({ verified: true, frame_count: 2, byte_length: 8, nonzero_byte_count: 8 });
    expect(reconcileProductInputLeg(events, op, { ...leg, pcm_sha256_chain: "0".repeat(64) })).toMatchObject({ verified: false, reason: "harness_product_pcm_digest_or_metric_mismatch" });
    expect(reconcileProductInputLeg([events[1]!, events[0]!], op, leg).verified).toBe(true);
  });

  it("requires zero outgoing bytes for governed silence and rejects a missing frame proof", () => {
    const op = operation("a02_silence");
    const bytes = Buffer.alloc(8);
    const events = [frame(op.runId, op.id, 1, bytes)];
    const leg = { frame_count: 1, byte_length: 8, pcm_digest_algorithm: "sha-256-chain-v1", pcm_sha256_chain: chain([bytes]), nonzero_sample_count: 0 };
    expect(reconcileProductInputLeg(events, op, leg).verified).toBe(true);
    expect(reconcileProductInputLeg([], op, leg)).toMatchObject({ verified: false, reason: "harness_frame_receipts_unavailable" });
  });
});

describe("scenario-aware terminal verdict prerequisites", () => {
  const recovery = (runId: string, seq: number): LabEvent => ({ runId, seq, kind: "cleanup.recovery", source: "canonical", at: new Date(), payload: { complete: true, receipt: { complete: true, live_cleanup_complete: true, live_resources_zero: true, components: { builder: { status: "completed", cleanup_complete: true, discovery_complete: true, authoritative_zero_tasks: true, discovered_task_count: 0 } } } }, dedupeKey: null });
  const absent = (runId: string, seq: number, kind: string, payload: Record<string, unknown> = {}): LabEvent => ({ runId, seq, kind, source: "worker", at: new Date(), payload, dedupeKey: null });

  it("allows exact pre-resource S01/S02 assertions without inventing browser/provider joins, while ordinary runs cannot pass vacuously", () => {
    for (const scenarioId of ["V-S01", "V-S02"] as const) {
      const run = testRun({ scenarioId, observedDeployment: {}, verdicts: initialVerdicts() });
      const probes = scenarioId === "V-S01"
        ? S01_FRONTEND_GRANT_VARIANTS.map((variant, index) => absent(run.id, index + 1, "security.invalid_grant_probe", { variant, rejected: true, exact_response_target: true, no_session_cookie: true, no_redirect: true }))
        : S02_VALIDATION_VARIANTS.map((variant, index) => {
          const expected = variant === "malformed_wav" ? "AUDIO_FORMAT_UNSUPPORTED" : ["oversized_audio", "fixture_metadata_bytes"].includes(variant) ? "AUDIO_TOO_LARGE" : variant === "fixture_metadata_duration" ? "AUDIO_DURATION_LIMIT" : variant === "unsupported_fixture" ? "FIXTURE_NOT_FOUND" : variant === "text_limit" ? "TEXT_TOO_LARGE" : ["unknown_fields", "malformed_id", "malformed_sha", "unsupported_scenario", "invalid_capture_policy"].includes(variant) ? "ZodError" : "TARGET_NOT_ALLOWED";
          return absent(run.id, index + 1, "security.pre_resource_validation_probe", { variant, rejected: true, expected_error_class: expected, observed_error_class: expected, production_validator: "exact-production-validator" });
        });
      const next = probes.length + 1;
      const scenarioEvents = scenarioId === "V-S01"
        ? [
          ...S01_OAUTH_VARIANTS.map((variant, index) => absent(run.id, next + index, "security.oauth_boundary_probe", { variant, rejected: true })),
          absent(run.id, next + S01_OAUTH_VARIANTS.length, "security.direct_fault_scope_probe", { rejected: true, fault_credential_distinct: true }),
          absent(run.id, next + S01_OAUTH_VARIANTS.length + 1, "security.oauth_family_cleanup", { complete: true, authorization_code_cleanup_handle_used: true, authorization_code_family_terminalized: true, access_token_issued: true, refresh_token_issued: true, refresh_family_revocation_receipt: true, access_revocation_receipt: true, access_token_denied_after_revocation: true, refresh_token_denied_after_revocation: true, durable_terminal_state_verified: true, raw_tokens_excluded: true }),
        ]
        : [
          absent(run.id, next, "security.shared_validator_equivalence", { internal_validator_supplement: true, variant_count: S02_VALIDATION_VARIANTS.length, production_boundary_assertion: "security.mcp_boundary_probe" }),
          { ...absent(run.id, next + 1, "security.s02_surface_coverage", {
            schema: "sophia_voice_lab_s02_surface_coverage_v1",
            public_authenticated_mcp_variants: [...S02_HTTP_VARIANTS],
            internal_startup_only_variants: ["fixture_metadata_bytes", "fixture_metadata_duration", "malformed_wav", "oversized_audio"],
            unsupported_fixture_public_mcp: true,
            raw_audio_public_surface: false,
            raw_audio_surface_reason: "no_public_raw_audio_surface",
            fixture_startup_receipt: { schema: "sophia_voice_lab_fixture_startup_v1", status: "verified", expected_manifest_sha256: BUNDLED_FIXTURE_MANIFEST_SHA256, observed_manifest_sha256: BUNDLED_FIXTURE_MANIFEST_SHA256, manifest_version: 1, fixture_count: 5, immutable_files_verified: true, raw_audio_public_surface: false },
          }), source: "canonical" },
          ...S02_HTTP_VARIANTS.map((variant, index) => s02Boundary(run.id, next + index + 2, variant)),
        ];
      const tail = next + scenarioEvents.length;
      const events = [...probes, ...scenarioEvents,
        absent(run.id, tail, "security.pre_resource_allocation_fence", { active_run_count_unchanged: true, browser_context_absent: true, browser_lease_absent: true, canonical_session_absent: true, provider_session_absent: true, tts_process_invocations: 0 }),
        absent(run.id, tail + 1, "cleanup.browser_context_absent"), absent(run.id, tail + 2, "cleanup.browser_lease_absent", { authoritative_ledger_read: true }), recovery(run.id, tail + 3)];
      expect(deriveCompletedVerdicts(run, events, [])).toMatchObject({ harness: "pass", provider: "unavailable", product: "unavailable", evidence: "pass" });
      const nearMiss = events.filter((event) => event.payload.variant !== (scenarioId === "V-S01" ? "wrong_run" : "malformed_sha"));
      expect(deriveCompletedVerdicts(run, nearMiss, []).harness).toBe("fail");
      if (scenarioId === "V-S02") {
        const boundary = events.filter((event) => event.kind === "security.mcp_boundary_probe");
        expect(boundary.every((event, index) => isExactS02McpBoundaryProbe(event, index === 0 ? null : boundary[index - 1]!))).toBe(true);

        const duplicateProbe = structuredClone(events);
        const duplicateBoundary = duplicateProbe.filter((event) => event.kind === "security.mcp_boundary_probe");
        duplicateBoundary[1]!.payload.probe_id_sha256 = duplicateBoundary[0]!.payload.probe_id_sha256;
        ((duplicateBoundary[1]!.payload.audit_receipts as Array<Record<string, unknown>>)[0]!).probe_id_sha256 = duplicateBoundary[0]!.payload.probe_id_sha256;
        expect(deriveCompletedVerdicts(run, duplicateProbe, []).harness).toBe("fail");

        const missingRequestHash = structuredClone(events);
        const missingRequest = missingRequestHash.find((event) => event.kind === "security.mcp_boundary_probe")!.payload.request as Record<string, unknown>;
        delete missingRequest.raw_body_sha256;
        expect(deriveCompletedVerdicts(run, missingRequestHash, []).harness).toBe("fail");

        const duplicateAudit = structuredClone(events);
        const duplicateAuditReceipts = duplicateAudit.find((event) => event.kind === "security.mcp_boundary_probe")!.payload.audit_receipts as Array<Record<string, unknown>>;
        duplicateAuditReceipts.push({ ...duplicateAuditReceipts[0]! });
        expect(deriveCompletedVerdicts(run, duplicateAudit, []).harness).toBe("fail");

        const staleAudit = structuredClone(events);
        const staleBoundary = staleAudit.find((event) => event.kind === "security.mcp_boundary_probe")!;
        ((staleBoundary.payload.audit_receipts as Array<Record<string, unknown>>)[0]!).observed_at = new Date(new Date(String((staleBoundary.payload.request as Record<string, unknown>).started_at)).getTime() - 1).toISOString();
        expect(deriveCompletedVerdicts(run, staleAudit, []).harness).toBe("fail");
      }
      const ordinary = testRun({ ...run, scenarioId: "V-A01" });
      expect(deriveCompletedVerdicts(ordinary, events, []).harness).toBe("fail");
    }
  });

  it("represents the absent governed product clock as unavailable rather than a false failure", () => {
    expect(deriveCompletedVerdicts(testRun({ scenarioId: "V-F02" }), [], [])).toEqual({ harness: "unavailable", product: "unavailable", provider: "unavailable", auth: "unavailable", evidence: "unavailable" });
  });
});

describe("strict canonical finalization", () => {
  it("recomputes the canonical transcript digest and rejects identity or content drift", () => {
    const run = testRun({ scenarioId: "V-F01", canonicalSessionId: "session-lab-1", threadId: "thread-lab-1" });
    const messages = [
      { approximate: false, content: "synthetic request", created_at: "2026-08-23T10:00:00.000Z", final: true, message_id: "message-1", provider_event_id: null, redaction_level: "synthetic", role: "user", sequence: 1, source: "voice", turn_id: "turn-1" },
      { approximate: false, content: "synthetic reply", created_at: "2026-08-23T10:00:01.000Z", final: true, message_id: "message-2", provider_event_id: "provider-2", redaction_level: "synthetic", role: "assistant", sequence: 2, source: "voice", turn_id: "turn-1" },
    ];
    const sorted = (value: unknown): string => Array.isArray(value) ? `[${value.map(sorted).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${sorted(child)}`).join(",")}}` : JSON.stringify(value);
    const finalizedAt = "2026-08-23T10:00:00.000Z";
    const retentionExpiresAt = "2026-08-24T10:00:00.000Z";
    const providerExpiresAt = run.expiresAt.toISOString();
    const transcript = { schema: "sophia_voice_lab_canonical_transcript_v1", source: "sophia_session_messages", synthetic: true, principal_id: run.principalId, test_run_id: run.testRunId, scenario_id: run.scenarioId, scenario_version: run.scenarioVersion, environment: run.environment, session_id: run.canonicalSessionId, thread_id: run.threadId, expected_deployment: run.target.expectedDeployment, message_revision: 2, message_count: 2, input_message_count: 1, output_message_count: 1, turn_boundary_count: 1, digest_algorithm: "sha-256", canonicalization: "utf8-json-sort-keys-compact-ascii-v1", sha256: sha256(sorted(messages)), provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, raw_audio_excluded: true, messages, turn_boundaries: [{ turn_id: "turn-1", first_sequence: 1, last_sequence: 2, input_message_count: 1, output_message_count: 1 }] };
    const event = { runId: run.id, seq: 1, kind: "session.finalized", source: "canonical", at: new Date(), payload: { receipt: { test_run_id: run.testRunId, cleanup_obligation_id_sha256: sha256(run.cleanupObligationId), synthetic_isolated: true, finalized_at: finalizedAt, provider_expires_at: providerExpiresAt, retention_hours: 24, retention_anchor: "finalized_at", retention_expires_at: retentionExpiresAt, exclusions: { memory: true, offline_pipeline: true, learning: true, ordinary_product_analytics: true, ordinary_user_projects: true, shared_spaces: true, debrief: true }, evidence_receipt: { storage: "supabase", object_path: `voice-lab/${run.testRunId}.json`, sha256: "e".repeat(64) }, canonical_transcript: transcript } }, dedupeKey: null } as LabEvent;
    expect(isCanonicalFinalizationReceipt(run, event)).toBe(true);
    const drifted = structuredClone(event); ((drifted.payload.receipt as any).canonical_transcript.messages[0] as any).content = "drifted";
    expect(isCanonicalFinalizationReceipt(run, drifted)).toBe(false);
    const ephemeral = structuredClone(event); ((ephemeral.payload.receipt as any).evidence_receipt as any).storage = "local_ephemeral";
    expect(isCanonicalFinalizationReceipt(run, ephemeral)).toBe(false);
    const wrongExpiry = structuredClone(event); (wrongExpiry.payload.receipt as any).retention_expires_at = "2026-08-24T09:59:59.000Z";
    expect(isCanonicalFinalizationReceipt(run, wrongExpiry)).toBe(false);
    const wrongProviderExpiry = structuredClone(event); (wrongProviderExpiry.payload.receipt as any).provider_expires_at = new Date(run.expiresAt.getTime() + 1).toISOString();
    expect(isCanonicalFinalizationReceipt(run, wrongProviderExpiry)).toBe(false);
    const driftedTranscriptProviderExpiry = structuredClone(event); ((driftedTranscriptProviderExpiry.payload.receipt as any).canonical_transcript as any).provider_expires_at = new Date(run.expiresAt.getTime() - 1).toISOString();
    expect(isCanonicalFinalizationReceipt(run, driftedTranscriptProviderExpiry)).toBe(false);
    const extraExclusion = structuredClone(event); (extraExclusion.payload.receipt as any).exclusions.unexpected = true;
    expect(isCanonicalFinalizationReceipt(run, extraExclusion)).toBe(false);
  });
});
