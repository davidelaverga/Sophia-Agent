import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

import { expect, vi } from "vitest";

import { labError, VoiceLabError } from "../src/domain.js";
import { D02GatewayClient, type D02GatewaySettlementReceipt } from "../src/d02-gateway.js";
import type { NewOperation } from "../src/ledger.js";
import type { VoiceLabLedger } from "../src/ledger.js";
import { canonicalRequestHash, sha256, type AuthenticatedCaller } from "../src/security.js";
import { VoiceLabService } from "../src/service.js";
import { evaluateScenarioAssertions } from "../src/worker.js";
import { testConfig, testRun } from "./helpers.js";
import { deriveRecoveryBrowserBinding } from "../src/recovery-control.js";
import { ownership } from "./execution-cleanup-fixture.js";
import { classifyRetainedRecoveryResponse } from "../src/retained-recovery-response.js";

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

/** Complete authenticated service flow with synthetic controller/Gateway signatures.
 * Shared unchanged across the Memory and PostgreSQL adapters. */
export async function verifyD02ServiceIngestion(ledger: VoiceLabLedger, retentionCut?: "before_owner" | "after_owner" | "after_gateway_commit") {
    const config = testConfig();
    const gatewayKeys = generateKeyPairSync("ed25519");
    const gatewayPublic = gatewayKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    config.d02GatewayReceiptAuthority = { keyId: "gateway-source-test", publicKeySpkiBase64: gatewayPublic, publicKeysById: { "gateway-source-test": gatewayPublic } };
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
    const browserBinding = deriveRecoveryBrowserBinding(run.id, lease.workerId, lease.leaseEpoch);
    const browserContextHash = browserBinding.browser_context_id_sha256;
    await ledger.bindRecoveryBrowserContext(run.id, lease.workerId, lease.leaseEpoch, browserBinding);
    const acquired = ownership(run)[0]!;
    await ledger.appendEvent(run.id, acquired.kind, acquired.source, acquired.payload);
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
    await ledger.preserveRecoveryExecutionOwnership(run.id);

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
    // C4 release gate: the consumed dispatch and exact freeze must survive
    // deletion of raw run_events. The independent controller can restart the
    // worker immediately after this response, so preservation cannot be deferred
    // to later worker maintenance or inferred from an absent lease.
    expect.soft(await ledger.getRecoveryControl(run.id), "D02 authority must be retained before dispatch acknowledgement").toMatchObject({
      d02Journal: {
        terminationRequestIdSha256: sha256(terminationRequestId),
        commandContentSha256: String(commandAttached.data.content_sha256),
        gatewayFreezeRequestSha256: String(freezeEvent.payload.freeze_request_sha256),
        dispatchClaimSha256: dispatchClaim.dispatch_claim_sha256,
        dispatchClaimEventSeq: dispatchClaim.event_seq,
        frozenProviderConnectionEpochs: commandEvidence.frozen_provider_connection_epochs,
      },
    });
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
    // Synthetic events advance by milliseconds; do not ask the real clock to
    // attest an observation before that deliberately ordered loss timestamp.
    await new Promise(resolve => setTimeout(resolve, Math.max(1, lossObservedAt.getTime() - Date.now() + 1)));
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
    const { signature: _gatewaySignature, ...unsignedGateway } = gatewayReceipt;
    gatewayReceipt.signature = sign(null, Buffer.from(canonicalRequestHash(unsignedGateway), "hex"), gatewayKeys.privateKey).toString("base64url");
    const settleSpy = vi.spyOn(gateway, "settle").mockResolvedValue(gatewayReceipt);
    const readSpy = vi.spyOn(gateway, "readSettlement").mockRejectedValue(new VoiceLabError(
      labError("D02_GATEWAY_SETTLEMENT_PENDING", "Synthetic receipt not committed", "evidence", true)));
    const authority = config.attestationAuthorities.deployment_control;
    const unsignedSource = {
      schema: "sophia_voice_lab_d02_render_worker_termination_receipt_v1",
      receipt_id: terminationRequestId, termination_request_id: terminationRequestId,
      run_id: run.id, test_run_id_sha256: sha256(run.testRunId), cleanup_obligation_id_sha256: sha256(run.cleanupObligationId),
      environment: run.environment, expected_deployment: run.target.expectedDeployment,
      authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authority_key_id: authority.keyId,
      audience: "sophia-voice-lab-browser-worker-termination-receipt",
      binding: {
        worker_service_id_sha256: finalEvidence.worker_service_id_sha256,
        provider_session_id_sha256: finalEvidence.provider_session_id_sha256,
        provider_admission_id_sha256: finalEvidence.provider_admission_id_sha256,
        provider_connection_epoch: finalEvidence.provider_connection_epoch,
        frozen_provider_connection_epochs: finalEvidence.frozen_provider_connection_epochs,
        browser_worker_id_sha256: workerHash, browser_lease_epoch: lease.leaseEpoch, browser_context_id_sha256: browserContextHash,
      },
      render: {
        before_service_response_sha256: finalEvidence.before_service_response_sha256,
        after_service_response_sha256: finalEvidence.after_service_response_sha256,
        before_deploy_id_sha256: beforeDeployHash, after_deploy_id_sha256: beforeDeployHash,
        before_deploy_response_sha256: sha256("before-deploy-response"), after_deploy_response_sha256: sha256("after-deploy-response"),
        before_instance_response_sha256: sha256("before-instance-response"), after_instance_response_sha256: sha256("after-instance-response"),
        before_instance_set_sha256: beforeInstanceSetHash, after_instance_set_sha256: finalEvidence.after_instance_set_sha256,
        before_worker_owner_instance_id_sha256: workerHash, before_worker_owner_membership_count: 1,
        replacement_worker_owner_instance_id_sha256: replacementWorkerHash, replacement_worker_owner_membership_count: 1,
        lost_worker_present_before_restart: true, lost_worker_absent_after_restart: true,
        dispatch_attempt_id_sha256: sha256(dispatchAttemptId), dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256,
        dispatch_claim_event_seq: dispatchEvent.seq,
        action_request_sha256: actionRequestHash, action_accepted_response_sha256: finalEvidence.render_action_accepted_response_sha256,
        action_settled_snapshot_sha256: finalEvidence.render_action_settled_snapshot_sha256,
        action_http_status: 200, action_requested_at: finalEvidence.action_requested_at,
        action_accepted_at: finalEvidence.action_accepted_at, action_settled_at: finalEvidence.action_settled_at,
        old_worker_instances_absent: true, replacement_worker_instances_observed: true, action_state: "settled_live_replacement",
      },
      voice_lab: { worker_loss_observation: observation },
      gateway: { settlement_schema_status: "not_yet_included", settlement_receipt_included: false },
      nonce: "n".repeat(32), issued_at: actionSettledAt.toISOString(), expires_at: new Date(actionSettledAt.getTime() + 300_000).toISOString(),
      signature_algorithm: "ed25519-sha256-canonical-request-v1",
    };
    const source = signEnvelope(unsignedSource, DEPLOYMENT_CONTROL_PRIVATE_KEY);
    const sourceEvidence = { ...finalEvidence, local_controller_receipt: source, local_controller_receipt_sha256: canonicalRequestHash(source) };
    // Outer attestation signatures do not replace the independent source signature.
    for (const [badSource, expectedCode] of [
      [{ ...source, signature: "s".repeat(86) }, "ATTESTATION_SIGNATURE_INVALID"],
      [signEnvelope({ ...unsignedSource, environment: "staging" }, DEPLOYMENT_CONTROL_PRIVATE_KEY), "ATTESTATION_CROSS_JOIN_FAILED"],
      [signEnvelope({ ...unsignedSource, render: { ...unsignedSource.render, after_service_response_sha256: sha256("foreign-snapshot") } }, DEPLOYMENT_CONTROL_PRIVATE_KEY), "ATTESTATION_CROSS_JOIN_FAILED"],
    ] as const) {
      const bad = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", {
        ...sourceEvidence, local_controller_receipt: badSource, local_controller_receipt_sha256: canonicalRequestHash(badSource),
      }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
      await expect(service.attachExternalAttestation(deploymentCaller, bad, { argumentHash: canonicalRequestHash(bad), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: expectedCode } });
      expect(settleSpy).not.toHaveBeenCalled();
    }
    const wrongDigest = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", {
      ...sourceEvidence, local_controller_receipt_sha256: sha256("wrong-source-digest"),
    }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    await expect(service.attachExternalAttestation(deploymentCaller, wrongDigest, { argumentHash: canonicalRequestHash(wrongDigest), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    expect(settleSpy).not.toHaveBeenCalled();
    const final = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", sourceEvidence), DEPLOYMENT_CONTROL_PRIVATE_KEY);
    const verifyPartialRetention = async () => {
      const prior = (await ledger.getRun(run.id))!;
      await ledger.updateRun(run.id, prior.version, { retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
      await ledger.purgeExpiredRetention(new Date(), 10);
      expect(await ledger.getRun(run.id)).toBeNull();
      const calls = settleSpy.mock.calls.length;
      if (retentionCut === "before_owner") {
        const expires = new Date(actionSettledAt.getTime() + 1);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, expires.getTime() - Date.now() + 2)));
        const expiredSource = signEnvelope({ ...unsignedSource, expires_at: expires.toISOString() }, DEPLOYMENT_CONTROL_PRIVATE_KEY);
        const expiredFinal = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", {
          ...sourceEvidence, local_controller_receipt: expiredSource, local_controller_receipt_sha256: canonicalRequestHash(expiredSource),
        }), DEPLOYMENT_CONTROL_PRIVATE_KEY);
        const before = (await ledger.getRecoveryControl(run.id))!;
        await expect(service.attachExternalAttestation(deploymentCaller, expiredFinal, { argumentHash: canonicalRequestHash(expiredFinal), requestIdHash: sha256(randomUUID()) })).rejects.toThrow("OWNER_RECEIPT_TIME_INVALID");
        expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
      }
      const result = await service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
      expect(result).toMatchObject({ status: "unavailable", error_class: "RETAINED_D02_PROVIDER_SETTLEMENT_UNAVAILABLE",
        data: { proof_status: "retained_owner_only", certification_available: false, provider_settlement_proof_sha256: null, live_cleanup_complete: false } });
      const control = (await ledger.getRecoveryControl(run.id))!;
      expect(control.d02OwnerDeath?.signedReceiptSha256).toBe(canonicalRequestHash(source));
      expect(control.d02ProviderSettlement).toBeUndefined();
      expect(settleSpy.mock.calls).toHaveLength(calls);
      expect(await ledger.getRun(run.id)).toBeNull();
      expect(await ledger.countActiveRuns()).toBe(1);
      const replay = await service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
      expect(replay.data).toEqual(result.data);
      expect((await ledger.getRecoveryControl(run.id))?.version).toBe(control.version);
    };
    if (retentionCut === "before_owner") { await verifyPartialRetention(); return; }
    const ownerWrite = vi.spyOn(ledger, "persistRetainedD02OwnerDeath");
    ownerWrite.mockRejectedValueOnce(new Error("synthetic owner storage outage"));
    await expect(service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).rejects.toThrow("synthetic owner storage outage");
    expect(settleSpy).not.toHaveBeenCalled();
    expect((await ledger.getRecoveryControl(run.id))?.d02OwnerDeath).toBeUndefined();
    settleSpy.mockResolvedValueOnce({ ...gatewayReceipt, provider_settlement_sha256: sha256("foreign-browser-provider-settlement") });
    await expect(service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    expect((await ledger.getRecoveryControl(run.id))?.d02OwnerDeath).toBeDefined();
    expect((await ledger.getRecoveryControl(run.id))?.d02ProviderSettlement).toBeUndefined();
    if (retentionCut === "after_owner") { await verifyPartialRetention(); return; }
    const providerWrite = vi.spyOn(ledger, "persistRetainedD02ProviderSettlement");
    providerWrite.mockRejectedValueOnce(new Error("synthetic provider storage outage"));
    await expect(service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).rejects.toThrow("synthetic provider storage outage");
    expect((await ledger.getRecoveryControl(run.id))?.d02ProviderSettlement).toBeUndefined();
    expect((await ledger.listEvents(run.id, 0, 100)).events.some(event => event.kind === "product.d02_gateway_browser_worker_termination_settled")).toBe(false);
    if (retentionCut === "after_gateway_commit") {
      const prior = (await ledger.getRun(run.id))!;
      await ledger.updateRun(run.id, prior.version, { retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
      await ledger.purgeExpiredRetention(new Date(), 10);
      const before = (await ledger.getRecoveryControl(run.id))!;
      const settleCalls = settleSpy.mock.calls.length;
      const attach = () => service.attachExternalAttestation(deploymentCaller, final,
        { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
      readSpy.mockRejectedValueOnce(new VoiceLabError(labError("D02_GATEWAY_SETTLEMENT_PENDING", "Synthetic unauthorized lookup", "authorization", false)));
      await expect(attach()).rejects.toMatchObject({ detail: { category: "authorization" } });
      expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
      readSpy.mockResolvedValueOnce({ ...gatewayReceipt, signature: "A".repeat(86) });
      await expect(attach()).rejects.toThrow();
      expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
      readSpy.mockResolvedValueOnce({ ...gatewayReceipt, provider_settlement_sha256: sha256("foreign-settlement") });
      await expect(attach()).rejects.toThrow();
      expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
      readSpy.mockResolvedValue(gatewayReceipt);
      providerWrite.mockRejectedValueOnce(new Error("retained provider write lost"));
      await expect(attach()).rejects.toThrow("retained provider write lost");
      expect(await ledger.getRecoveryControl(run.id)).toEqual(before);
      const result = await attach();
      expect(classifyRetainedRecoveryResponse(result, final as { evidence: { kind: string } }, canonicalRequestHash(result)))
        .toMatchObject({ code: "RETAINED_RECOVERY_ONLY_NOT_CERTIFIED", facts: { signed_claim_sha256: canonicalRequestHash(final) } });
      expect(result).toMatchObject({ status: "ok", data: { proof_status: "retained_recovery_facts_only",
        raw_evidence_purged: true, certification_available: false, live_cleanup_complete: false } });
      const retained = (await ledger.getRecoveryControl(run.id))!;
      expect(retained.d02ProviderSettlement?.gatewayReceiptSha256).toBe(canonicalRequestHash(gatewayReceipt));
      expect(await ledger.getRun(run.id)).toBeNull();
      expect(await ledger.countActiveRuns()).toBe(1);
      expect(settleSpy.mock.calls).toHaveLength(settleCalls);
      expect(readSpy).toHaveBeenCalledTimes(5);
      expect(JSON.stringify(readSpy.mock.calls)).not.toContain("provider-session-worker-loss");
      const replay = await attach();
      expect(replay.data).toEqual(result.data);
      expect((await ledger.getRecoveryControl(run.id))?.version).toBe(retained.version);
      expect(readSpy).toHaveBeenCalledTimes(5);
      return;
    }
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(new Date(String(final.expires_at)).getTime() + 901_000));
      await service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
    } finally {
      vi.useRealTimers();
    }
    const retained = (await ledger.getRecoveryControl(run.id))!;
    expect(retained.d02OwnerDeath?.signedReceiptSha256).toBe(canonicalRequestHash(source));
    expect(retained.d02ProviderSettlement?.gatewayReceiptSha256).toBe(canonicalRequestHash(gatewayReceipt));
    expect(retained.liveCleanupComplete).toBe(false);
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
    const beforePurge = (await ledger.getRun(run.id))!;
    await ledger.updateRun(run.id, beforePurge.version, { retentionPurgeDueAt: new Date(0), retentionPurgePending: true });
    await ledger.purgeExpiredRetention(new Date(), 10);
    expect(await ledger.getRun(run.id)).toBeNull();
    expect((await ledger.getRecoveryControl(run.id))?.d02OwnerDeath).toEqual(retained.d02OwnerDeath);
    expect((await ledger.getRecoveryControl(run.id))?.d02ProviderSettlement).toEqual(retained.d02ProviderSettlement);
    expect((await ledger.getRecoveryControl(run.id))?.liveCleanupComplete).toBe(false);
    const settleCalls = settleSpy.mock.calls.length;
    const retainedReadback = await service.attachExternalAttestation(deploymentCaller, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) });
    expect(retainedReadback).toMatchObject({ status: "ok", run_id: null, event_cursor: null,
      data: { proof_status: "retained_recovery_facts_only", raw_evidence_purged: true, certification_available: false,
        owner_death_proof_sha256: retained.d02OwnerDeath!.proofSha256,
        provider_settlement_proof_sha256: retained.d02ProviderSettlement!.proofSha256 } });
    expect(settleSpy.mock.calls).toHaveLength(settleCalls);
    expect(await ledger.getRun(run.id)).toBeNull();
    const badSignature = { ...final, signature: "s".repeat(86) };
    await expect(service.attachExternalAttestation(deploymentCaller, badSignature, { argumentHash: canonicalRequestHash(badSignature), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_SIGNATURE_INVALID" } });
    for (const drifted of [
      { ...sourceEvidence, local_controller_receipt_sha256: sha256("different-retained-source") },
      { ...sourceEvidence, product_provider_cleanup_settlement_sha256: sha256("different-retained-provider") },
    ]) {
      const foreign = signEnvelope(unsignedEnvelope(config, terminal, "deployment_control", drifted), DEPLOYMENT_CONTROL_PRIVATE_KEY);
      await expect(service.attachExternalAttestation(deploymentCaller, foreign, { argumentHash: canonicalRequestHash(foreign), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_CROSS_JOIN_FAILED" } });
    }
    await expect(service.attachExternalAttestation({ ...deploymentCaller, subject: "different-controller" }, final, { argumentHash: canonicalRequestHash(final), requestIdHash: sha256(randomUUID()) })).rejects.toMatchObject({ detail: { code: "ATTESTATION_AUTHORITY_MISMATCH" } });
    expect(settleSpy.mock.calls).toHaveLength(settleCalls);
    expect(await ledger.getRun(run.id)).toBeNull();
    // The same internal ledger boundary can verify exact durable readback after
    // raw retention without reconstructing a run or weakening CAS for new facts.
    const ownerReplay = await ledger.persistRetainedD02OwnerDeath(ownerWrite.mock.calls.at(-1)![0]);
    expect(ownerReplay).toMatchObject({ replay: true, proof: retained.d02OwnerDeath });
    const providerReplay = await ledger.persistRetainedD02ProviderSettlement(providerWrite.mock.calls.at(-1)![0]);
    expect(providerReplay).toMatchObject({ replay: true, proof: retained.d02ProviderSettlement });
}
