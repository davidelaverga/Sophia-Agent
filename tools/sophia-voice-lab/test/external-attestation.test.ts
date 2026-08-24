import { createPrivateKey, randomUUID, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { labError } from "../src/domain.js";
import { D02GatewayClient, type D02GatewaySettlementReceipt } from "../src/d02-gateway.js";
import type { NewOperation } from "../src/ledger.js";
import { MemoryVoiceLabLedger } from "../src/memory-ledger.js";
import { canonicalRequestHash, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { evaluateScenarioAssertions } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";

const EXTERNAL_CLIENT_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIHLJCBgca/OR6tE4RKi00/GdpKQGpePJ1FF/AIFo+Gbc";
const DEPLOYMENT_CONTROL_PRIVATE_KEY = "MC4CAQAwBQYDK2VwBCIEIDhkSCJg4Qta3ZaccGJIGUnCLA/WT8IuvVrBV11Vg0Ot";

function signEnvelope(unsigned: Record<string, unknown>, privateKey = EXTERNAL_CLIENT_PRIVATE_KEY): Record<string, unknown> {
  const key = createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalRequestHash(unsigned), "hex"), key).toString("base64url") };
}

function startOperation(runId: string): NewOperation {
  return { id: randomUUID(), runId, callerId: "caller-1", type: "start", idempotencyKey: "attestation-start", requestHash: sha256("attestation-start"), input: {} };
}

function unsignedEnvelope(config: ReturnType<typeof testConfig>, run: ReturnType<typeof testRun>, authorityName: "external_mcp_client" | "deployment_control", evidence: Record<string, unknown>): Record<string, unknown> {
  const authority = config.attestationAuthorities[authorityName];
  const attestationId = randomUUID();
  return {
    schema: "sophia_voice_lab_external_attestation_v1",
    attestation_id: attestationId,
    run_id: run.id,
    test_run_id_sha256: sha256(run.testRunId),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    environment: run.environment,
    expected_deployment: run.target.expectedDeployment,
    issuer: authority.issuer,
    audience: "sophia-voice-lab-attestation",
    authority_key_id: authority.keyId,
    jti: attestationId,
    nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    evidence,
  };
}

async function a03Fixture(auditUsesDurableHash = false) {
  const config = testConfig();
  const ledger = new MemoryVoiceLabLedger("test");
  const service = new VoiceLabService(ledger, config, async () => []);
  const run = testRun({ scenarioId: "V-A03", state: "ready", expiresAt: new Date(Date.now() + 60_000) });
  await ledger.createRunWithOperation(run, startOperation(run.id), { global: 1, caller: 1 });
  const start = await ledger.claimNextOperation("attestation-worker", 30);
  await ledger.markOperationExecuting(start!.operation.id, "attestation-worker", start!.operation.leaseEpoch);
  await ledger.finishOperation(start!.operation.id, "attestation-worker", start!.operation.leaseEpoch, "succeeded", {}, null);
  await ledger.upsertBrowserLease(run.id, "attestation-worker", 60);

  const publicInput = { run_id: run.id, text: "hello", idempotency_key: "a03-response-loss" };
  const operationInput = { ...publicInput, _admission: { duration_ms: 250, bytes: 8_000 } };
  const publicRequestHash = canonicalRequestHash(publicInput);
  const requestHash = canonicalRequestHash(operationInput);
  const auditArgumentHash = auditUsesDurableHash ? requestHash : publicRequestHash;
  const created = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: "a03-response-loss", requestHash, input: operationInput });
  const claimed = await ledger.claimNextOperation("attestation-worker", 30);
  await ledger.markOperationExecuting(claimed!.operation.id, "attestation-worker", claimed!.operation.leaseEpoch);
  const operation = await ledger.finishOperation(claimed!.operation.id, "attestation-worker", claimed!.operation.leaseEpoch, "succeeded", { schedule_receipt: { scheduled: true } }, null);
  expect(operation.id).toBe(created.operation.id);

  const acceptedAt = operation.createdAt;
  const firstReceiptAt = new Date(acceptedAt.getTime() + 1);
  const responseLostAt = new Date(acceptedAt.getTime() + 2);
  const retryAt = new Date(acceptedAt.getTime() + 3);
  const replayAt = new Date(acceptedAt.getTime() + 4);
  const retryReceiptAt = new Date(acceptedAt.getTime() + 5);
  const initialClientRequest = sha256("a03-initial-client-request");
  const retryClientRequest = sha256("a03-retry-client-request");
  const retryResponse = sha256("a03-retry-response-bytes");
  await ledger.recordAuthAudit({ runId: run.id, callerId: run.callerId, action: "mcp.tool_response", argumentHash: auditArgumentHash, outcome: "allowed", detail: {
    tool: "speak", client_request_id_hash: initialClientRequest, response_sha256: sha256("unobserved-initial-response"), operation_id_sha256: sha256(operation.id), run_id_sha256: sha256(run.id), replay: false, authorization_kind: "oauth",
  }, observedAt: firstReceiptAt });
  await ledger.appendEvent(run.id, "operation.speak.idempotent_replay", "mcp", { operation_id: operation.id, exact_request_hash_replay: true, no_new_operation: true }, "a03-replay", replayAt);
  await ledger.recordAuthAudit({ runId: run.id, callerId: run.callerId, action: "mcp.tool_response", argumentHash: auditArgumentHash, outcome: "allowed", detail: {
    tool: "speak", client_request_id_hash: retryClientRequest, response_sha256: retryResponse, operation_id_sha256: sha256(operation.id), run_id_sha256: sha256(run.id), replay: true, authorization_kind: "oauth",
  }, observedAt: retryReceiptAt });

  const authority = config.attestationAuthorities.external_mcp_client;
  const attestationId = randomUUID();
  const unsigned = {
    schema: "sophia_voice_lab_external_attestation_v1",
    attestation_id: attestationId,
    run_id: run.id,
    test_run_id_sha256: sha256(run.testRunId),
    cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
    scenario_id: "V-A03",
    scenario_version: "vt00.scenarios.v1",
    environment: run.environment,
    expected_deployment: run.target.expectedDeployment,
    issuer: authority.issuer,
    audience: "sophia-voice-lab-attestation",
    authority_key_id: authority.keyId,
    jti: attestationId,
    nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1",
    evidence: {
      kind: "a03_http_response_loss",
      authority: "external_mcp_client",
      operation_id: operation.id,
      replayed_operation_id: operation.id,
      request_sha256: operation.requestHash,
      idempotency_key_sha256: sha256(operation.idempotencyKey),
      initial_client_request_id_sha256: initialClientRequest,
      retry_client_request_id_sha256: retryClientRequest,
      retry_response_sha256: retryResponse,
      accepted_at: acceptedAt.toISOString(),
      response_lost_at: responseLostAt.toISOString(),
      retry_at: retryAt.toISOString(),
      transport_outcome: "connection_closed_after_durable_acceptance",
      initial_response_observed: false,
    },
  };
  const caller: AuthenticatedCaller = { subject: authority.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:external_mcp_client"]), authorizationKind: "attestation" };
  return { service, ledger, run, caller, unsigned };
}

type P01AdmissionMode = "valid" | "missing" | "shape_drift" | "durable_hash_drift";

async function p01Fixture(
  statusOverrides: Partial<Record<number, string>> = {},
  admissionMode: P01AdmissionMode = "valid",
) {
  const config = testConfig({
    SOPHIA_VOICE_LAB_OAUTH_ISSUER: "https://oauth.test",
    SOPHIA_VOICE_LAB_OAUTH_RESOURCE: "https://voice-lab.test/mcp",
    SOPHIA_VOICE_LAB_OAUTH_RESOURCE_METADATA_URL: "https://voice-lab.test/.well-known/oauth-protected-resource/mcp",
    SOPHIA_VOICE_LAB_OAUTH_CLIENT_METADATA_URL: "https://chatgpt.com/oauth/client.json",
    SOPHIA_VOICE_LAB_OAUTH_CLIENT_REDIRECT_URI: "https://chatgpt.com/connector_platform_oauth_redirect",
    SOPHIA_VOICE_LAB_OAUTH_OPERATOR_SUBJECT: "voice-lab-private-operator",
    SOPHIA_VOICE_LAB_OAUTH_CONSENT_SECRET: "oauth-consent-secret-00000000000000001",
    SOPHIA_VOICE_LAB_OAUTH_TOKEN_PEPPER: "oauth-token-pepper-0000000000000000001",
  });
  const ledger = new MemoryVoiceLabLedger("test");
  const service = new VoiceLabService(ledger, config, async () => []);
  const run = testRun({ scenarioId: "V-P01", state: "reserved", expiresAt: new Date(Date.now() + 600_000) });
  const taskStartedAt = new Date(run.createdAt.getTime() - 5_000);
  const installedAt = new Date(taskStartedAt.getTime() - 5_000);
  const startInput = {
    environment: run.environment,
    target: {
      frontend_url: run.target.frontendUrl,
      gateway_url: run.target.gatewayUrl,
      voice_url: run.target.voiceUrl,
      langgraph_url: run.target.langgraphUrl,
      expected_deployment: run.target.expectedDeployment,
      expected_dependencies: run.target.expectedDependencies,
    },
    scenario_id: run.scenarioId,
    scenario_version: run.scenarioVersion,
    capture_policy: {
      raw_audio: run.capturePolicy.rawAudio,
      screenshot: run.capturePolicy.screenshot,
      video: run.capturePolicy.video,
      retention_hours: run.capturePolicy.retentionHours,
    },
    idempotency_key: "p01-platform-start",
  };
  await ledger.createRunWithOperation(run, {
    id: randomUUID(),
    runId: run.id,
    callerId: run.callerId,
    type: "start",
    idempotencyKey: startInput.idempotency_key,
    requestHash: canonicalRequestHash(startInput),
    input: startInput,
  }, { global: 1, caller: 1 });
  const workerId = "p01-platform-worker";
  const finishNext = async (result: Record<string, unknown>) => {
    const claimed = await ledger.claimNextOperation(workerId, 30);
    expect(claimed).not.toBeNull();
    await ledger.markOperationExecuting(claimed!.operation.id, workerId, claimed!.operation.leaseEpoch);
    return ledger.finishOperation(claimed!.operation.id, workerId, claimed!.operation.leaseEpoch, "succeeded", result, null);
  };
  const start = await finishNext({ run_state: "active" });
  await ledger.upsertBrowserLease(run.id, workerId, 60);
  const createSpeak = async (text: string, idempotencyKey: string) => {
    const publicInput = { run_id: run.id, text, idempotency_key: idempotencyKey };
    const admission = admissionMode === "shape_drift"
      ? { duration_ms: 750, bytes: 33_119, extra: true }
      : { duration_ms: 750, bytes: 33_119 };
    const input = admissionMode === "missing" ? publicInput : { ...publicInput, _admission: admission };
    const requestHash = admissionMode === "durable_hash_drift"
      ? canonicalRequestHash(publicInput)
      : canonicalRequestHash(input);
    const created = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey, requestHash, input });
    return { created, publicInput };
  };
  const speakOneSetup = await createSpeak("one", "p01-speak-one");
  const speakOne = await finishNext({ operation_state: "succeeded" });
  expect(speakOne.id).toBe(speakOneSetup.created.operation.id);
  const speakTwoSetup = await createSpeak("two", "p01-speak-two");
  const speakTwo = await finishNext({ operation_state: "succeeded" });
  expect(speakTwo.id).toBe(speakTwoSetup.created.operation.id);
  let fresh = (await ledger.getRun(run.id))!;
  await ledger.updateRun(run.id, fresh.version, { state: "ending" });
  const endInput = { run_id: run.id, idempotency_key: "p01-platform-end" };
  const endCreated = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "end", idempotencyKey: endInput.idempotency_key, requestHash: canonicalRequestHash(endInput), input: endInput });
  const end = await finishNext({ operation_state: "succeeded" });
  expect(end.id).toBe(endCreated.operation.id);
  fresh = (await ledger.getRun(run.id))!;
  const terminal = await ledger.updateRun(run.id, fresh.version, { state: "pending_external_evidence", cleanupComplete: true, terminalError: null });
  const manifestId = randomUUID();
  const manifestSha256 = sha256("p01-pre-attestation-manifest");
  await ledger.saveEvidence({ runId: run.id, manifestId, manifestSha256, schemaVersion: "sophia.voice-lab.evidence.v1", revisionSeq: 1, artifactRefs: [], createdAt: new Date() });

  const tools = ["get_capabilities", "start_voice_run", "wait_for_turn", "speak", "wait_for_turn", "speak", "wait_for_turn", "inspect_voice_run", "end_voice_run", "export_voice_evidence"] as const;
  const statuses = ["ok", "accepted", "ok", "completed", "ok", "completed", "ok", "running", "completed", "completed"] as const;
  const operationByOrdinal = new Map([[2, start], [4, speakOne], [6, speakTwo], [9, end]]);
  const publicArgumentHashByOperationId = new Map([
    [start.id, canonicalRequestHash(startInput)],
    [speakOne.id, canonicalRequestHash(speakOneSetup.publicInput)],
    [speakTwo.id, canonicalRequestHash(speakTwoSetup.publicInput)],
    [end.id, canonicalRequestHash(endInput)],
  ]);
  const oauthClientHash = sha256(config.oauth!.clientMetadataUrl);
  const calls = [] as Array<Record<string, unknown>>;
  for (let index = 0; index < tools.length; index += 1) {
    const ordinal = index + 1;
    const operation = operationByOrdinal.get(ordinal);
    const argumentSha256 = operation
      ? publicArgumentHashByOperationId.get(operation.id)!
      : sha256(`p01-argument-${ordinal}`);
    const responseSha256 = sha256(`p01-response-${ordinal}`);
    const resultRequestIdSha256 = sha256(`p01-result-request-${ordinal}`);
    const runIdSha256 = ordinal === 1 ? null : sha256(run.id);
    const operationIdSha256 = operation ? sha256(operation.id) : null;
    calls.push({ ordinal, observed_order: ordinal, tool_name: tools[index], argument_sha256: argumentSha256, response_sha256: responseSha256, result_request_id_sha256: resultRequestIdSha256, run_id_sha256: runIdSha256, operation_id_sha256: operationIdSha256 });
    const status = statusOverrides[ordinal] ?? statuses[index];
    const detail: Record<string, unknown> = {
      tool: tools[index], status, response_sha256: responseSha256, result_request_id_sha256: resultRequestIdSha256, run_id_sha256: runIdSha256, operation_id_sha256: operationIdSha256,
      authorization_kind: "oauth", oauth_client_id_sha256: oauthClientHash, oauth_token_id_sha256: sha256("p01-oauth-token-family"), replay: false,
      operation_state: ordinal === 2 ? "accepted" : [4, 6, 9].includes(ordinal) ? "succeeded" : null,
      run_state: ordinal === 8 ? "active" : ordinal >= 9 ? terminal.state : "ready",
      condition_satisfied: [3, 5, 7].includes(ordinal), cleanup_complete: ordinal >= 9, evidence_state: ordinal >= 9 ? "available" : null,
      manifest_id_sha256: ordinal >= 9 ? sha256(manifestId) : null, manifest_sha256: ordinal >= 9 ? manifestSha256 : null,
    };
    await ledger.recordAuthAudit({ runId: ordinal === 1 ? null : run.id, callerId: run.callerId, action: "mcp.tool_response", argumentHash: argumentSha256, outcome: "allowed", detail, observedAt: new Date(run.createdAt.getTime() + ordinal * 10) });
  }
  const taskCompletedAt = new Date(Date.now() + 1_000);
  const evidence = {
    kind: "p01_platform_plugin_task", authority: "platform_plugin", registered_app_id: config.registeredAppId!, plugin_version: config.pluginVersion,
    platform_task_id_sha256: sha256("p01-platform-task"), platform_thread_id_sha256: sha256("p01-platform-thread"), install_receipt_sha256: sha256("p01-install-receipt"), plugin_package_sha256: config.pluginPackageSha256,
    installed_at: installedAt.toISOString(), fresh_task_started_at: taskStartedAt.toISOString(), fresh_task_completed_at: taskCompletedAt.toISOString(), high_level_call_count: 10,
    calls, polling_call_count: 0, polling_calls: [], operation_ids: [start.id, speakOne.id, speakTwo.id, end.id], adaptive_observation_call_ordinal: 5, adaptive_followup_call_ordinal: 6,
    prohibited_tool_audit_passed: true, raw_javascript_used: false, local_runner_used: false, manual_takeover_used: false, exact_deployment_discovered: true, adaptive_followup_completed: true,
  };
  const validate = (candidate = evidence) => (service as unknown as { validateExternalAttestationEvidence(run: typeof terminal, evidence: Record<string, unknown>): Promise<void> }).validateExternalAttestationEvidence(terminal, candidate);
  return { validate, evidence };
}

describe("source-owned external attestation boundary", () => {
  it("requires successful canonical P01 calls, succeeded operations, cleanup, and the exact exported manifest", async () => {
    await expect((await p01Fixture()).validate()).resolves.toBeUndefined();
    await expect((await p01Fixture({ 9: "timeout" })).validate()).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    await expect((await p01Fixture({ 10: "unavailable" })).validate()).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
  });

  it("joins public P01 speak arguments only through one exact augmented admission", async () => {
    await expect((await p01Fixture({}, "missing")).validate()).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    await expect((await p01Fixture({}, "shape_drift")).validate()).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    await expect((await p01Fixture({}, "durable_hash_drift")).validate()).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
  });

  it("atomically claims one immutable run/kind slot and replays the exact signed envelope", async () => {
    const { service, ledger, run, caller, unsigned } = await a03Fixture();
    const signed = signEnvelope(unsigned);
    const attach = () => service.attachExternalAttestation(caller, signed, { argumentHash: canonicalRequestHash(signed), requestIdHash: sha256(randomUUID()) });
    const [left, right] = await Promise.all([attach(), attach()]);
    expect(new Set([left.data.event_seq, right.data.event_seq]).size).toBe(1);
    expect([left.data.replay, right.data.replay].filter(Boolean)).toHaveLength(1);
    const events = await ledger.listEvents(run.id, 0, 100);
    expect(events.events.filter((event) => event.kind === "external.attestation.a03_http_response_loss")).toHaveLength(1);

    const replay = await attach();
    expect(replay.data).toMatchObject({ replay: true, event_seq: left.data.event_seq, content_sha256: left.data.content_sha256 });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(new Date(String(unsigned.expires_at)).getTime() + 1));
      await expect(attach()).resolves.toMatchObject({ data: { replay: true, event_seq: left.data.event_seq } });

      const conflictingId = randomUUID();
      const conflicting = signEnvelope({ ...unsigned, attestation_id: conflictingId, jti: conflictingId, nonce: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "") });
      await expect(service.attachExternalAttestation(caller, conflicting, { argumentHash: canonicalRequestHash(conflicting), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CONFLICT" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("joins the public MCP speak hash to the separately augmented durable operation hash", async () => {
    const good = await a03Fixture();
    const signedGood = signEnvelope(good.unsigned);
    await expect(good.service.attachExternalAttestation(good.caller, signedGood, { argumentHash: canonicalRequestHash(signedGood), requestIdHash: sha256(randomUUID()) })).resolves.toMatchObject({ status: "completed" });

    const wrongBoundary = await a03Fixture(true);
    const signedWrong = signEnvelope(wrongBoundary.unsigned);
    await expect(wrongBoundary.service.attachExternalAttestation(wrongBoundary.caller, signedWrong, { argumentHash: canonicalRequestHash(signedWrong), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
  });

  it("requires the source-specific signing key even with the correct transport identity", async () => {
    const { service, caller, unsigned } = await a03Fixture();
    const signed = signEnvelope(unsigned, DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(caller, signed, { argumentHash: canonicalRequestHash(signed), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_SIGNATURE_INVALID" } });
  });

  it("requires a signed one-shot restart command before accepting the exact D02 API process-restart proof", async () => {
    const config = testConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const gateway = new D02GatewayClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
    });
    const service = new VoiceLabService(ledger, config, async () => [], undefined, undefined, gateway);
    const run = testRun({
      scenarioId: "V-D02",
      state: "ready",
      canonicalSessionId: "canonical-session-d02",
      threadId: "canonical-thread-d02",
      providerSessionId: "provider-session-d02",
      providerEpoch: 7,
      expiresAt: new Date(Date.now() + 600_000),
    });
    await ledger.createRunWithOperation(run, startOperation(run.id), { global: 1, caller: 1 });
    const claimedStart = await ledger.claimNextOperation("d02-worker", 30);
    await ledger.markOperationExecuting(claimedStart!.operation.id, "d02-worker", claimedStart!.operation.leaseEpoch);
    await ledger.finishOperation(claimedStart!.operation.id, "d02-worker", claimedStart!.operation.leaseEpoch, "succeeded", {}, null);
    const lease = await ledger.upsertBrowserLease(run.id, "d02-worker", 60);
    const browserWorkerHash = sha256("d02-worker");
    await ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
      worker_id_sha256: browserWorkerHash,
      browser_lease_epoch: lease.leaseEpoch,
      operation_id: claimedStart!.operation.id,
      engine: "chromium",
      version: "1",
      service_version: config.serviceVersion,
      acquired_at: new Date().toISOString(),
      raw_worker_identifier_excluded: true,
    }, "d02-browser-runtime");

    const created = await ledger.createOperation({ id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: "d02-restart-replay", requestHash: sha256("d02-restart-request"), input: { text: "restart-safe" } });
    const claimedSpeak = await ledger.claimNextOperation("d02-worker", 30);
    await ledger.markOperationExecuting(claimedSpeak!.operation.id, "d02-worker", claimedSpeak!.operation.leaseEpoch);
    const operation = await ledger.finishOperation(claimedSpeak!.operation.id, "d02-worker", claimedSpeak!.operation.leaseEpoch, "succeeded", { schedule_receipt: { scheduled: true } }, null);
    expect(operation.id).toBe(created.operation.id);
    const utteranceId = "utterance-d02";
    await ledger.appendEvent(run.id, "utterance.resolved", "worker", { operation_id: operation.id, utterance_id: utteranceId }, "d02-input-resolved");
    await ledger.appendEvent(run.id, "audio.input.scheduled", "browser", { operation_id: operation.id, utterance_id: utteranceId }, "d02-input-scheduled");
    await ledger.appendEvent(run.id, "audio.input.started", "browser", { operation_id: operation.id, utterance_id: utteranceId }, "d02-input-started");
    await ledger.appendEvent(run.id, "audio.input.completed", "browser", { operation_id: operation.id, utterance_id: utteranceId }, "d02-input-completed");
    await ledger.appendEvent(run.id, "audio.input.product_leg", "product", { receipt: { operation_id: operation.id, utterance_id: utteranceId } }, "d02-input-product-leg");
    await ledger.appendEvent(run.id, "audio.input.product_turn", "product", { receipt: { operation_id: operation.id, utterance_id: utteranceId, source: "public_user_turn" } }, "d02-input-product-turn");

    const base = Math.max(Date.now(), run.createdAt.getTime()) + 50;
    const beforeBootAt = new Date(base);
    const restartRequestedAt = new Date(base + 10);
    const newProcessStartedAt = new Date(base + 20);
    const afterBootAt = new Date(base + 30);
    const replayObservedAt = new Date(base + 40);
    const beforeBootHash = sha256("d02-before-boot");
    const afterBootHash = sha256("d02-after-boot");
    const beforeInstanceHash = sha256("d02-before-instance");
    const afterInstanceHash = sha256("d02-after-instance");
    const beforeVersionHash = sha256("d02-before-version-response");
    const afterVersionHash = sha256("d02-after-version-response");
    const continuityProjection = {
      session_id_sha256: sha256(run.canonicalSessionId!),
      thread_id_sha256: sha256(run.threadId!),
      principal_id_hmac: sha256("d02-principal-hmac"),
      test_run_id_sha256: sha256(run.testRunId),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      provider_session_id_sha256: sha256(run.providerSessionId!),
      provider_admission_id_sha256: sha256("d02-provider-admission"),
      voice_lab_run_id_sha256: sha256(run.id),
      browser_worker_id_sha256: browserWorkerHash,
      browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: sha256("d02-browser-context"),
      voice_runtime_instance_id_sha256: sha256("d02-voice-runtime-instance"),
      expected_deployment: run.target.expectedDeployment,
      session_status: "active" as const,
      message_revision: 0,
      canonical_provider_state: "active" as const,
      provider_connection_epoch: run.providerEpoch!,
      provider_pending_connection_epoch: null,
    };
    vi.spyOn(gateway, "observeContinuity").mockImplementation(async (_origin, request) => {
      const receiptId = request.phase === "before_api_restart"
        ? "00000000-0000-4000-8000-000000000011"
        : "00000000-0000-4000-8000-000000000012";
      const core = {
        schema: "sophia_voice_lab_d02_product_continuity_observation_v1" as const,
        receipt_id: receiptId,
        restart_request_id_sha256: sha256(request.restart_request_id),
        phase: request.phase,
        request_sha256: canonicalRequestHash(request),
        product_service_boot_id_sha256: request.product_service_boot_id_sha256,
        render_action_request_sha256: request.render_action_request_sha256,
        prior_observation_receipt_sha256: request.prior_observation_receipt_sha256,
        continuity_projection: continuityProjection,
        cleanup_obligation_state: "open" as const,
        cleanup_lifecycle_phase: "session_provisional" as const,
        d02_freeze_absent: true as const,
        database_observed_at: request.observed_at,
        issuer: "sophia-gateway" as const,
        audience: "sophia-voice-lab-d02-product-continuity" as const,
        authority_key_id: config.d02GatewayReceiptAuthority!.keyId,
        jti: receiptId,
        nonce: `${request.phase}-continuity-receipt-nonce-0000000000000000`,
        issued_at: request.observed_at,
        expires_at: new Date(new Date(request.observed_at).getTime() + 600_000).toISOString(),
        signature_algorithm: "ed25519-sha256-canonical-request-v1" as const,
      };
      return { ...core, receipt_sha256: canonicalRequestHash(core), signature: "A".repeat(86) };
    });
    await ledger.recordAuthAudit({ runId: null, callerId: "system.web", action: "service:web_boot", argumentHash: beforeBootHash, outcome: "allowed", detail: { instance_id_sha256: beforeInstanceHash, version_response_sha256: beforeVersionHash, service_version: config.serviceVersion }, observedAt: beforeBootAt });

    const restartRequestId = randomUUID();
    const commandEvidence = {
      kind: "d02_restart_command",
      authority: "deployment_control",
      restart_request_id: restartRequestId,
      operation_id: operation.id,
      request_sha256: operation.requestHash,
      idempotency_key_sha256: sha256(operation.idempotencyKey),
      before_boot_id_sha256: beforeBootHash,
      before_instance_id_sha256: beforeInstanceHash,
      before_version_response_sha256: beforeVersionHash,
      browser_worker_id_sha256: browserWorkerHash,
      browser_lease_epoch: lease.leaseEpoch,
      provider_restart_request_sha256: sha256("d02-provider-restart-request"),
      requested_at: restartRequestedAt.toISOString(),
      target_service: "sophia-voice-lab-mcp",
      restart_mode: "one_shot_after_durable_acceptance",
      response_loss_expected: true,
      provider_mutation_authorized: false,
      one_shot: true,
    };
    const deploymentCaller: AuthenticatedCaller = { subject: config.attestationAuthorities.deployment_control.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" };
    const command = signEnvelope(unsignedEnvelope(config, run, "deployment_control", commandEvidence), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, command, { argumentHash: canonicalRequestHash(command), requestIdHash: sha256(randomUUID()) })).resolves.toMatchObject({ data: { attestation_kind: "d02_restart_command", immutable: true } });

    await ledger.recordAuthAudit({ runId: null, callerId: "system.web", action: "service:web_boot", argumentHash: afterBootHash, outcome: "allowed", detail: { instance_id_sha256: afterInstanceHash, version_response_sha256: afterVersionHash, service_version: config.serviceVersion }, observedAt: afterBootAt });
    await ledger.appendEvent(run.id, "operation.speak.idempotent_replay", "mcp", { operation_id: operation.id, exact_request_hash_replay: true, no_new_operation: true }, "d02-operation-replay", replayObservedAt);
    const continuityQuery = { run_id: run.id, restart_request_id_sha256: sha256(restartRequestId), operation_id: operation.id, after_boot_id_sha256: afterBootHash };
    await expect(service.getD02BrowserContinuity(deploymentCaller, continuityQuery)).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, replayObservedAt.getTime() - Date.now() + 5)));
    expect(await ledger.heartbeatBrowserLease(run.id, "d02-worker", lease.leaseEpoch, 60)).toBe(true);
    const browserContinuity = await service.getD02BrowserContinuity(deploymentCaller, continuityQuery);
    const durableReceiptHash = canonicalRequestHash({ operation_id: operation.id, operation_type: operation.type, request_hash: operation.requestHash, state: operation.state, result: operation.result });
    const finalEvidence = {
      kind: "d02_api_process_restart",
      authority: "deployment_control",
      operation_id: operation.id,
      request_sha256: operation.requestHash,
      idempotency_key_sha256: sha256(operation.idempotencyKey),
      before_boot_id_sha256: beforeBootHash,
      after_boot_id_sha256: afterBootHash,
      restart_request_id_sha256: sha256(restartRequestId),
      before_instance_id_sha256: beforeInstanceHash,
      after_instance_id_sha256: afterInstanceHash,
      before_version_response_sha256: beforeVersionHash,
      after_version_response_sha256: afterVersionHash,
      original_receipt_sha256: durableReceiptHash,
      replay_receipt_sha256: durableReceiptHash,
      browser_worker_id_sha256: browserWorkerHash,
      browser_lease_epoch: lease.leaseEpoch,
      canonical_session_id_sha256: sha256(run.canonicalSessionId!),
      thread_id_sha256: sha256(run.threadId!),
      provider_session_id_sha256: sha256(run.providerSessionId!),
      provider_connection_epoch: run.providerEpoch!,
      restart_requested_at: restartRequestedAt.toISOString(),
      new_process_started_at: newProcessStartedAt.toISOString(),
      replay_observed_at: replayObservedAt.toISOString(),
      provider_restart_request_sha256: commandEvidence.provider_restart_request_sha256,
      provider_restart_accepted_response_sha256: sha256("d02-provider-restart-response"),
      local_controller_receipt_sha256: sha256("d02-local-controller-receipt"),
      browser_continuity_proof: browserContinuity,
      old_process_exited: true,
      new_process_started: true,
      browser_worker_continuity: true,
      duplicate_injection_count: 0,
    };
    const wrongRestart = signEnvelope(unsignedEnvelope(config, run, "deployment_control", { ...finalEvidence, restart_request_id_sha256: sha256(randomUUID()) }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, wrongRestart, { argumentHash: canonicalRequestHash(wrongRestart), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });

    const final = signEnvelope(unsignedEnvelope(config, run, "deployment_control", finalEvidence), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).resolves.toMatchObject({ data: { attestation_kind: "d02_api_process_restart", immutable: true } });
    expect(await ledger.releaseBrowserLease(run.id, "d02-worker", lease.leaseEpoch)).toBe(true);
    await expect(service.getD02BrowserContinuity(deploymentCaller, continuityQuery)).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    await ledger.upsertBrowserLease(run.id, "replacement-worker", 60);
    await expect(service.getD02BrowserContinuity(deploymentCaller, continuityQuery)).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    const events = await ledger.listEvents(run.id, 0, 100);
    expect(events.events.filter((event) => event.kind === "external.attestation.d02_restart_command")).toHaveLength(1);
    expect(events.events.filter((event) => event.kind === "external.attestation.d02_api_process_restart")).toHaveLength(1);
    expect(events.events.filter((event) => event.kind === "product.d02_api_process_restart_precondition")).toHaveLength(1);
    expect(events.events.filter((event) => event.kind === "product.d02_api_process_restart_continuity")).toHaveLength(1);
    const [operations, authAudit] = await Promise.all([ledger.listOperations(run.id), ledger.listAuthAudit(run.id)]);
    const evaluation = evaluateScenarioAssertions(run, events.events, operations, authAudit);
    expect(evaluation.harness).toContainEqual(expect.objectContaining({ id: "d02.mcp_api_process_restart_and_reattach", status: "pass" }));
    expect(evaluation.product).toContainEqual(expect.objectContaining({ id: "d02.product_gate", status: "pass", reason: null }));

    const withoutProductContinuity = evaluateScenarioAssertions(run, events.events.filter((event) => !event.kind.startsWith("product.d02_api_process_restart_")), operations, authAudit);
    expect(withoutProductContinuity.product).toContainEqual(expect.objectContaining({ id: "d02.product_gate", status: "unavailable", reason: "exact_product_session_thread_provider_continuity_receipt_not_attached" }));
    const driftedProductContinuity = evaluateScenarioAssertions(run, events.events.map((event) => event.kind === "product.d02_api_process_restart_continuity"
      ? { ...event, payload: { ...event.payload, gateway_receipt: { ...(event.payload.gateway_receipt as Record<string, unknown>), continuity_projection: { ...((event.payload.gateway_receipt as Record<string, unknown>).continuity_projection as Record<string, unknown>), provider_session_id_sha256: sha256("foreign-provider-session") } } } }
      : event), operations, authAudit);
    expect(driftedProductContinuity.product).toContainEqual(expect.objectContaining({ id: "d02.product_gate", status: "fail", reason: "product_session_thread_provider_continuity_receipt_conflicted_or_failed_cross_join" }));
  });

  it("joins the source-specific worker command, durable lease loss, and owning Gateway settlement", async () => {
    const config = testConfig();
    const ledger = new MemoryVoiceLabLedger("test");
    const gateway = new D02GatewayClient(config, async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ frozen: true, idempotent_replay: false, freeze_request_sha256: canonicalRequestHash(body) }), { status: 202 });
    });
    const service = new VoiceLabService(ledger, config, async () => [], undefined, undefined, gateway);
    const run = testRun({ scenarioId: "V-D02", state: "ready", providerSessionId: "provider-session-worker-loss", providerEpoch: 7, expiresAt: new Date(Date.now() + 600_000) });
    const initialStartOperation = startOperation(run.id);
    await ledger.createRunWithOperation(run, initialStartOperation, { global: 1, caller: 1 });
    const start = await ledger.claimNextOperation("worker-loss-before", 30);
    await ledger.markOperationExecuting(start!.operation.id, "worker-loss-before", start!.operation.leaseEpoch);
    await ledger.finishOperation(start!.operation.id, "worker-loss-before", start!.operation.leaseEpoch, "succeeded", {}, null);
    const lease = await ledger.upsertBrowserLease(run.id, "worker-loss-before", 60);
    const workerHash = sha256("worker-loss-before");
    const browserContextHash = sha256("browser-context-worker-loss");
    await ledger.appendEvent(run.id, "harness.browser_context_bound", "canonical", {
      schema: "sophia_voice_lab_browser_context_binding_v1",
      test_run_id_sha256: sha256(run.testRunId),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      voice_lab_run_id_sha256: sha256(run.id),
      browser_worker_id_sha256: workerHash,
      browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      context_allocation: "deterministic_run_worker_lease_v1",
      driver_attested: true,
      raw_run_worker_and_context_identifiers_excluded: true,
    }, "worker-loss-context");
    await ledger.appendEvent(run.id, "harness.browser_runtime_acquired", "canonical", {
      worker_id_sha256: workerHash,
      browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      operation_id: start!.operation.id,
      engine: "chromium",
      version: "1",
      service_version: config.serviceVersion,
      acquired_at: new Date().toISOString(),
      raw_worker_identifier_excluded: true,
    }, "worker-loss-runtime");

    const requestedAt = new Date();
    const terminationRequestId = randomUUID();
    const beforeDeployHash = sha256("worker-before-deploy");
    const beforeInstanceSetHash = sha256("worker-before-instance-set");
    const actionRequestHash = sha256("worker-render-action-request");
    const commandEvidence = {
      kind: "d02_browser_worker_termination_command",
      authority: "deployment_control",
      termination_request_id: terminationRequestId,
      run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      worker_service_id_sha256: sha256("srv-voice-lab-worker"),
      provider_session_id_sha256: sha256(run.providerSessionId!),
      provider_admission_id_sha256: sha256("provider-admission-worker-loss"),
      provider_connection_epoch: run.providerEpoch!,
      frozen_provider_connection_epochs: [5, 6, 7],
      browser_worker_id_sha256: workerHash,
      browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      before_worker_deploy_id_sha256: beforeDeployHash,
      before_worker_instance_set_sha256: beforeInstanceSetHash,
      before_worker_owner_instance_id_sha256: workerHash,
      before_worker_owner_membership_count: 1,
      render_action_request_sha256: actionRequestHash,
      requested_at: requestedAt.toISOString(),
      target_service: "sophia-voice-lab-worker",
      termination_mode: "render_service_restart_one_shot",
      worker_mutation_authorized: true,
      product_mutation_authorized: false,
      one_shot: true,
    };
    const deploymentCaller: AuthenticatedCaller = { subject: config.attestationAuthorities.deployment_control.subject, scopes: new Set(["voice_lab:attest", "voice_lab:attest:deployment_control"]), authorizationKind: "attestation" };
    const command = signEnvelope(unsignedEnvelope(config, run, "deployment_control", commandEvidence), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    const commandAttached = await service.attachExternalAttestation(deploymentCaller, command, { argumentHash: canonicalRequestHash(command), requestIdHash: sha256(randomUUID()) });
    const commandPhaseEvents = (await ledger.listEvents(run.id, 0, 100)).events;
    const freezeIntentEvent = commandPhaseEvents.find((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")!;
    const freezeEvent = commandPhaseEvents.find((event) => event.kind === "product.d02_gateway_browser_worker_termination_frozen")!;
    const commandEvent = commandPhaseEvents.find((event) => event.kind === "external.attestation.d02_browser_worker_termination_command")!;
    expect(commandPhaseEvents.filter((event) => event.kind === "product.d02_browser_worker_termination_freeze_pending")).toHaveLength(1);
    expect(freezeIntentEvent.seq).toBeLessThan(freezeEvent.seq);
    expect(freezeEvent.seq).toBeLessThan(commandEvent.seq);
    expect(freezeIntentEvent.payload).toEqual({
      schema: "sophia_voice_lab_d02_local_browser_worker_freeze_intent_v1",
      termination_request_id_sha256: sha256(terminationRequestId),
      command_evidence_sha256: canonicalRequestHash(commandEvidence),
      voice_lab_run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      provider_session_id_sha256: sha256(run.providerSessionId!),
      provider_admission_id_sha256: commandEvidence.provider_admission_id_sha256,
      provider_connection_epoch: run.providerEpoch,
      frozen_provider_connection_epochs: commandEvidence.frozen_provider_connection_epochs,
      browser_worker_id_sha256: workerHash,
      browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      render_action_request_sha256: actionRequestHash,
      requested_at: requestedAt.toISOString(),
      raw_run_operation_provider_and_browser_identifiers_excluded: true,
    });
    await expect(ledger.createOperation(initialStartOperation)).resolves.toMatchObject({ replay: true });
    await expect(ledger.createOperation({
      id: randomUUID(), runId: run.id, callerId: run.callerId, type: "speak", idempotencyKey: "post-freeze-new-operation",
      requestHash: sha256("post-freeze-new-operation"), input: { run_id: run.id, text: "must not dispatch" },
    })).rejects.toMatchObject({ detail: { code: "D02_RUN_FROZEN" } });
    const dispatchRequestedAt = new Date(commandEvent.at.getTime() + 1);
    const dispatchAttemptId = randomUUID();
    const dispatchRequest = {
      schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1",
      run_id: run.id,
      termination_request_id: terminationRequestId,
      command_attestation_id: String(command.attestation_id),
      command_content_sha256: String(commandAttached.data.content_sha256),
      command_event_seq: Number(commandAttached.data.event_seq),
      worker_service_id_sha256: commandEvidence.worker_service_id_sha256,
      action_request_sha256: actionRequestHash,
      dispatch_attempt_id: dispatchAttemptId,
      requested_at: dispatchRequestedAt.toISOString(),
    };
    const dispatchClaim = await service.claimD02RenderWorkerDispatch(deploymentCaller, dispatchRequest);
    expect(dispatchClaim).toMatchObject({ claimed: true, idempotent_replay: false, termination_request_id_sha256: sha256(terminationRequestId), dispatch_attempt_id_sha256: sha256(dispatchAttemptId), action_request_sha256: actionRequestHash });
    await expect(service.claimD02RenderWorkerDispatch(deploymentCaller, dispatchRequest)).resolves.toMatchObject({ idempotent_replay: true, dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256, event_seq: dispatchClaim.event_seq });
    await expect(service.claimD02RenderWorkerDispatch(deploymentCaller, { ...dispatchRequest, dispatch_attempt_id: randomUUID() })).rejects.toMatchObject({ detail: { code: "DEDUPE_CONFLICT" } });
    const validateExpiredCommand = (service as unknown as {
      validateExternalAttestationEvidence(run: typeof run, evidence: Record<string, unknown>, options: { requireD02FreezeReplay: boolean }): Promise<void>;
    }).validateExternalAttestationEvidence.bind(service);
    const freezeSpy = vi.spyOn(gateway, "freeze");
    freezeSpy.mockResolvedValueOnce({ frozen: true, idempotent_replay: false, freeze_request_sha256: String(freezeEvent.payload.freeze_request_sha256) });
    await expect(validateExpiredCommand(run, commandEvidence, { requireD02FreezeReplay: true })).rejects.toMatchObject({ detail: { code: "ATTESTATION_TIME_INVALID" } });
    freezeSpy.mockResolvedValueOnce({ frozen: true, idempotent_replay: true, freeze_request_sha256: String(freezeEvent.payload.freeze_request_sha256) });
    await expect(validateExpiredCommand(run, commandEvidence, { requireD02FreezeReplay: true })).resolves.toEqual({ gatewayFreezeIdempotentReplay: true });
    freezeSpy.mockRestore();

    const dispatchEvent = (await ledger.listEvents(run.id, 0, 100)).events.find((event) => event.kind === "product.d02_render_worker_dispatch_claimed")!;
    expect(commandEvent.seq).toBeLessThan(dispatchEvent.seq);
    const shutdownObservedAt = new Date(dispatchRequestedAt.getTime() + 1);
    const productProviderSettlementSha256 = sha256("d02-product-provider-cleanup-settlement");
    const shutdown = await ledger.appendEvent(run.id, "durability.browser_worker_shutdown_observed", "worker", {
      schema: "sophia_voice_lab_d02_browser_worker_shutdown_observation_v1",
      termination_request_id_sha256: sha256(terminationRequestId),
      voice_lab_run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      lost_browser_worker_id_sha256: workerHash,
      lost_browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      provider_session_id_sha256: commandEvidence.provider_session_id_sha256,
      provider_admission_id_sha256: commandEvidence.provider_admission_id_sha256,
      provider_connection_epoch: commandEvidence.provider_connection_epoch,
      frozen_provider_connection_epochs: commandEvidence.frozen_provider_connection_epochs,
      render_action_request_sha256: actionRequestHash,
      gateway_freeze_request_sha256: freezeEvent.payload.freeze_request_sha256,
      gateway_freeze_event_seq: freezeEvent.seq,
      command_event_seq: commandEvent.seq,
      render_dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256,
      render_dispatch_claim_event_seq: dispatchEvent.seq,
      product_provider_cleanup_acknowledged: true,
      product_provider_cleanup_settlement_sha256: productProviderSettlementSha256,
      product_provider_close_receipt_count: commandEvidence.frozen_provider_connection_epochs.length,
      product_provider_activation_abort_receipt_count: 0,
      product_provider_cleanup_epoch_union_matches_freeze: true,
      browser_context_closed: true,
      source: "worker_graceful_d02_restart",
      raw_run_worker_lease_context_and_product_identifiers_excluded: true,
      observed_at: shutdownObservedAt.toISOString(),
    }, `d02-worker-shutdown:${sha256(terminationRequestId)}`, shutdownObservedAt);
    expect(await ledger.releaseBrowserLease(run.id, "worker-loss-before", lease.leaseEpoch)).toBe(true);
    const terminal = await ledger.updateRun(run.id, run.version, { state: "aborted_driver_restart", terminalError: labError("BROWSER_SESSION_LOST", "Browser worker lease was lost.", "harness") });
    const lossObservedAt = new Date(shutdownObservedAt.getTime() + 1);
    const replacementWorkerHash = sha256("worker-loss-after");
    const loss = await ledger.appendEvent(run.id, "durability.browser_worker_loss_observed", "worker", {
      schema: "sophia_voice_lab_d02_browser_worker_loss_cross_join_v1",
      termination_request_id_sha256: sha256(terminationRequestId),
      lost_worker_id_sha256: workerHash,
      replacement_worker_id_sha256: replacementWorkerHash,
      lost_browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      old_worker_shutdown_event_seq: shutdown.seq,
      render_dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256,
      render_dispatch_claim_event_seq: dispatchEvent.seq,
      lease_expired_at: null,
      loss_observed_at: lossObservedAt.toISOString(),
      loss_source: "worker_graceful_d02_restart_cross_join",
      raw_worker_identifiers_excluded: true,
    }, `browser-worker-loss:${run.id}:${lease.leaseEpoch}`, lossObservedAt);
    await ledger.appendEvent(run.id, "durability.browser_worker_replacement_observed", "worker", {
      schema: "sophia_voice_lab_d02_browser_worker_replacement_observation_v1",
      termination_request_id_sha256: sha256(terminationRequestId),
      lost_browser_worker_id_sha256: workerHash,
      replacement_browser_worker_id_sha256: replacementWorkerHash,
      lost_browser_lease_epoch: lease.leaseEpoch,
      browser_context_id_sha256: browserContextHash,
      old_worker_shutdown_event_seq: shutdown.seq,
      loss_event_seq: loss.seq,
      render_dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256,
      source: "replacement_worker_startup_after_graceful_d02_restart",
      raw_worker_identifiers_excluded: true,
    }, `d02-worker-replacement:${sha256(terminationRequestId)}`, lossObservedAt);
    const observation = await service.getD02BrowserWorkerLossObservation(deploymentCaller, { run_id: run.id, termination_request_id_sha256: sha256(terminationRequestId) });
    expect(observation).toMatchObject({ loss_event_seq: loss.seq, browser_lease_absent: true, owning_gateway_settlement_included: false, provider_admission_id_sha256: commandEvidence.provider_admission_id_sha256, product_provider_cleanup_settlement_sha256: productProviderSettlementSha256 });

    const actionSettledAt = new Date(lossObservedAt.getTime() + 1);
    const finalEvidence = {
      kind: "d02_browser_worker_loss",
      authority: "deployment_control",
      termination_request_id_sha256: sha256(terminationRequestId),
      local_controller_receipt_sha256: sha256("worker-local-controller-receipt"),
      run_id_sha256: sha256(run.id),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      worker_service_id_sha256: commandEvidence.worker_service_id_sha256,
      provider_session_id_sha256: commandEvidence.provider_session_id_sha256,
      provider_admission_id_sha256: commandEvidence.provider_admission_id_sha256,
      provider_connection_epoch: commandEvidence.provider_connection_epoch,
      frozen_provider_connection_epochs: commandEvidence.frozen_provider_connection_epochs,
      product_provider_cleanup_settlement_sha256: productProviderSettlementSha256,
      browser_context_id_sha256: commandEvidence.browser_context_id_sha256,
      lost_worker_id_sha256: workerHash,
      replacement_worker_id_sha256: observation.replacement_browser_worker_id_sha256,
      lost_browser_lease_epoch: lease.leaseEpoch,
      loss_event_seq: loss.seq,
      loss_observed_at: lossObservedAt.toISOString(),
      render_action_request_sha256: actionRequestHash,
      render_action_accepted_response_sha256: sha256("worker-render-action-accepted"),
      render_action_settled_snapshot_sha256: sha256("worker-render-action-settled"),
      before_service_response_sha256: sha256("worker-service-before"),
      after_service_response_sha256: sha256("worker-service-after"),
      before_deploy_id_sha256: beforeDeployHash,
      after_deploy_id_sha256: beforeDeployHash,
      before_instance_set_sha256: beforeInstanceSetHash,
      after_instance_set_sha256: sha256("worker-after-instance-set"),
      lost_worker_owner_instance_id_sha256: workerHash,
      lost_worker_present_before_restart: true,
      lost_worker_absent_after_restart: true,
      replacement_worker_owner_instance_id_sha256: observation.replacement_browser_worker_id_sha256,
      replacement_worker_owner_membership_count: 1,
      render_dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256,
      command_requested_at: requestedAt.toISOString(),
      action_requested_at: dispatchRequestedAt.toISOString(),
      action_accepted_at: actionSettledAt.toISOString(),
      action_settled_at: actionSettledAt.toISOString(),
      action_kind: "render_worker_service_restart",
      restart_http_status: 200,
      old_worker_instances_absent: true,
      replacement_worker_instances_observed: true,
      gateway_settlement_receipt_included: false,
    };
    const drift = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", { ...finalEvidence, provider_admission_id_sha256: sha256("wrong-provider-admission") }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, drift, { argumentHash: canonicalRequestHash(drift), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });

    const futureActionAt = new Date(Date.now() + 60_000).toISOString();
    const futureAction = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", { ...finalEvidence, action_requested_at: futureActionAt, action_accepted_at: futureActionAt, action_settled_at: futureActionAt }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, futureAction, { argumentHash: canonicalRequestHash(futureAction), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });

    const gatewayReceiptId = randomUUID();
    const gatewayReceipt: D02GatewaySettlementReceipt = {
      schema: "sophia_voice_lab_gateway_browser_worker_termination_settlement_v1",
      receipt_id: gatewayReceiptId,
      termination_request_id_sha256: sha256(terminationRequestId),
      voice_lab_run_id_sha256: sha256(run.id),
      test_run_id_sha256: sha256(run.testRunId),
      cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      principal_id_hmac: sha256("worker-loss-principal"),
      scenario_id: "V-D02",
      scenario_version: run.scenarioVersion,
      environment: run.environment,
      expected_deployment: run.target.expectedDeployment,
      provider_session_id_sha256: sha256(run.providerSessionId!),
      provider_admission_id_sha256: finalEvidence.provider_admission_id_sha256,
      provider_connection_epoch: finalEvidence.provider_connection_epoch,
      frozen_provider_connection_epochs: finalEvidence.frozen_provider_connection_epochs,
      browser_worker_id_sha256: finalEvidence.lost_worker_id_sha256,
      browser_lease_epoch: finalEvidence.lost_browser_lease_epoch,
      browser_context_id_sha256: finalEvidence.browser_context_id_sha256,
      render_action_request_sha256: finalEvidence.render_action_request_sha256,
      render_action_accepted_response_sha256: finalEvidence.render_action_accepted_response_sha256,
      render_action_settled_snapshot_sha256: finalEvidence.render_action_settled_snapshot_sha256,
      loss_event_seq: finalEvidence.loss_event_seq,
      loss_observed_at: finalEvidence.loss_observed_at,
      voice_terminal_receipts_sha256: sha256("voice-terminal-worker-loss"),
      provider_settlement_sha256: productProviderSettlementSha256,
      cleanup_obligation_state: "closed",
      canonical_provider_state: "closed",
      canonical_pending_epoch: null,
      all_frozen_provider_epochs_terminal: true,
      provider_admission_absent: true,
      voice_provider_session_absent: true,
      gateway_browser_relay_absent: true,
      database_observed_at: actionSettledAt.toISOString(),
      issuer: "sophia-gateway",
      audience: "sophia-voice-lab-d02-gateway-settlement",
      authority_key_id: config.d02GatewayReceiptAuthority!.keyId,
      jti: gatewayReceiptId,
      nonce: "n".repeat(32),
      issued_at: actionSettledAt.toISOString(),
      expires_at: new Date(actionSettledAt.getTime() + 600_000).toISOString(),
      signature_algorithm: "ed25519-sha256-canonical-request-v1",
      signature: "s".repeat(86),
    };
    const settleSpy = vi.spyOn(gateway, "settle").mockResolvedValue(gatewayReceipt);
    const final = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", finalEvidence), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    settleSpy.mockResolvedValueOnce({ ...gatewayReceipt, provider_settlement_sha256: sha256("foreign-browser-provider-settlement") });
    await expect(service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(new Date(String(final.expires_at)).getTime() + 901_000));
      await service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
    } finally {
      vi.useRealTimers();
    }
    const [events, operations, authAudit] = await Promise.all([ledger.listEvents(run.id, 0, 100), ledger.listOperations(run.id), ledger.listAuthAudit(run.id)]);
    const evaluation = evaluateScenarioAssertions(terminal, events.events, operations, authAudit);
    expect(evaluation.harness).toContainEqual(expect.objectContaining({ id: "d02.browser_worker_termination_action", status: "pass" }));
    expect(evaluation.harness).toContainEqual(expect.objectContaining({ id: "d02.browser_worker_loss_abort_recovery", status: "pass", reason: null }));
    expect(evaluation.summary).toMatch(/certification withheld/i);

    const withoutGatewaySettlement = evaluateScenarioAssertions(terminal, events.events.filter((event) => event.kind !== "product.d02_gateway_browser_worker_termination_settled"), operations, authAudit);
    expect(withoutGatewaySettlement.harness).toContainEqual(expect.objectContaining({ id: "d02.browser_worker_loss_abort_recovery", status: "unavailable", reason: "gateway_browser_worker_termination_settlement_receipt_not_attached" }));

    const withDriftedGatewaySettlement = evaluateScenarioAssertions(terminal, events.events.map((event) => event.kind === "product.d02_gateway_browser_worker_termination_settled"
      ? { ...event, payload: { ...event.payload, settlement_request_sha256: sha256("foreign-settlement-request") } }
      : event), operations, authAudit);
    expect(withDriftedGatewaySettlement.harness).toContainEqual(expect.objectContaining({ id: "d02.browser_worker_loss_abort_recovery", status: "fail", reason: "gateway_browser_worker_termination_settlement_conflicted_or_failed_cross_join" }));

    const withForeignProductSettlement = evaluateScenarioAssertions(terminal, events.events.map((event) => {
      if (event.kind !== "product.d02_gateway_browser_worker_termination_settled") return event;
      const gatewayReceipt = {
        ...(event.payload.gateway_receipt as Record<string, unknown>),
        provider_settlement_sha256: sha256("foreign-product-provider-settlement"),
      };
      return {
        ...event,
        payload: {
          ...event.payload,
          gateway_receipt: gatewayReceipt,
          gateway_receipt_sha256: canonicalRequestHash(gatewayReceipt),
        },
      };
    }), operations, authAudit);
    expect(withForeignProductSettlement.harness).toContainEqual(expect.objectContaining({ id: "d02.browser_worker_loss_abort_recovery", status: "fail", reason: "gateway_browser_worker_termination_settlement_conflicted_or_failed_cross_join" }));
  });
});
