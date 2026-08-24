import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { D02RenderWorkerDispatchClaimResponseSchema, ExternalAttestationSchema } from "../../src/service.js";
import {
  D02BrowserWorkerLossObservationSchema,
  D02RenderWorkerTerminationInputSchema,
  D02WorkerTerminationControllerReceiptSchema,
  type D02BrowserWorkerLossObservation,
  type D02RenderWorkerTerminationInput,
  type D02WorkerTerminationControllerReceipt,
  type PublicAuthorityConfig,
  type SignedExternalAttestation,
  type TransportTokens,
} from "./contracts.js";
import { newUnsignedClaim, signD02WorkerTerminationReceipt, signExternalClaim, verifyD02WorkerTerminationReceipt } from "./crypto.js";
import {
  AttestationResponseCheckpointSchema,
  VerifiedAttestationReceiptSchema,
  postAttestationAndVerifyReplay,
  verifyPersistedExternalClaimSignature,
  type AttestationResponseCheckpoint,
  type VerifiedAttestationReceipt,
} from "./http.js";

const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;

interface RenderWorkerSnapshot {
  serviceId: string;
  serviceName: "sophia-voice-lab-worker";
  serviceType: "background_worker";
  serviceResponseSha256: string;
  deployResponseSha256: string;
  instanceResponseSha256: string;
  deployId: string;
  deployStatus: string;
  deployStartedAt: string;
  deploySettledAt: string | null;
  instanceIds: string[];
  instanceCreatedAt: Date[];
  instanceSetSha256: string;
}

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const RenderWorkerSnapshotRecordSchema = z.object({
  service_id: z.string().regex(/^srv-[0-9a-z]{20}$/),
  service_name: z.literal("sophia-voice-lab-worker"),
  service_type: z.literal("background_worker"),
  service_response_sha256: Sha256Schema,
  deploy_response_sha256: Sha256Schema,
  instance_response_sha256: Sha256Schema,
  deploy_id: z.string().regex(/^dep-[0-9a-z]{20}$/),
  deploy_status: z.string().regex(/^[a-z_]+$/),
  deploy_started_at: TimestampSchema,
  deploy_settled_at: TimestampSchema.nullable(),
  instance_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)).min(1),
  instance_created_at: z.array(TimestampSchema).min(1),
  instance_set_sha256: Sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.instance_ids.length !== value.instance_created_at.length || new Set(value.instance_ids).size !== value.instance_ids.length) context.addIssue({ code: "custom", message: "Render snapshot instance identities and timestamps must be one exact unique set." });
  if (canonicalRequestHash(value.instance_ids.map((id) => sha256(id)).sort()) !== value.instance_set_sha256) context.addIssue({ code: "custom", path: ["instance_set_sha256"], message: "Render snapshot instance-set hash mismatch." });
});

export const D02WorkerTerminationCheckpointSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("preflight_prepared"),
    termination_request_id: z.string().uuid(),
    command_requested_at: TimestampSchema,
    action_request_sha256: Sha256Schema,
    before_worker_owner_instance_id_sha256: Sha256Schema,
    before_worker_owner_membership_count: z.literal(1),
    before: RenderWorkerSnapshotRecordSchema,
  }).strict(),
  z.object({ phase: z.literal("command_prepared"), claim: ExternalAttestationSchema }).strict(),
  z.object({ phase: z.literal("command_attestation_response"), response: AttestationResponseCheckpointSchema }).strict(),
  z.object({ phase: z.literal("command_attached"), receipt: VerifiedAttestationReceiptSchema }).strict(),
  z.object({
    phase: z.literal("render_worker_dispatch_intent"),
    receipt: z.object({ action_request_sha256: Sha256Schema, dispatch_attempt_id: z.string().uuid(), dispatch_claim_request_sha256: Sha256Schema, requested_at: TimestampSchema }).strict(),
  }).strict(),
  z.object({
    phase: z.literal("render_worker_restart_accepted"),
    receipt: z.object({ action_request_sha256: Sha256Schema, action_accepted_response_sha256: Sha256Schema, dispatch_attempt_id_sha256: Sha256Schema, dispatch_claim_sha256: Sha256Schema, dispatch_claim_event_seq: z.number().int().positive(), http_status: z.literal(200), requested_at: TimestampSchema, accepted_at: TimestampSchema }).strict(),
  }).strict(),
  z.object({ phase: z.literal("render_worker_replacement_settled"), receipt: D02WorkerTerminationControllerReceiptSchema, receipt_sha256: Sha256Schema }).strict(),
  z.object({ phase: z.literal("final_prepared"), claim: ExternalAttestationSchema }).strict(),
  z.object({ phase: z.literal("final_attestation_response"), response: AttestationResponseCheckpointSchema }).strict(),
  z.object({ phase: z.literal("final_attached"), receipt: VerifiedAttestationReceiptSchema }).strict(),
]);

export type D02WorkerTerminationCheckpoint = z.infer<typeof D02WorkerTerminationCheckpointSchema>;

interface ResumeState {
  preflight?: Extract<D02WorkerTerminationCheckpoint, { phase: "preflight_prepared" }>;
  commandClaim?: SignedExternalAttestation;
  commandResponses: AttestationResponseCheckpoint[];
  commandReceipt?: VerifiedAttestationReceipt;
  dispatchIntent?: Extract<D02WorkerTerminationCheckpoint, { phase: "render_worker_dispatch_intent" }>["receipt"];
  accepted?: Extract<D02WorkerTerminationCheckpoint, { phase: "render_worker_restart_accepted" }>["receipt"];
  localReceipt?: D02WorkerTerminationControllerReceipt;
  localReceiptSha256?: string;
  finalClaim?: SignedExternalAttestation;
  finalResponses: AttestationResponseCheckpoint[];
  finalReceipt?: VerifiedAttestationReceipt;
}

export interface D02RenderWorkerTerminationResult {
  command_claim: SignedExternalAttestation;
  command_receipt: VerifiedAttestationReceipt;
  local_controller_receipt: D02WorkerTerminationControllerReceipt;
  local_controller_receipt_sha256: string;
  final_claim: SignedExternalAttestation;
  final_receipt: VerifiedAttestationReceipt;
  provider_action: {
    worker_service_id_sha256: string;
    action_request_sha256: string;
    action_accepted_response_sha256: string;
    action_settled_snapshot_sha256: string;
    before_instance_set_sha256: string;
    after_instance_set_sha256: string;
    state: "settled_live_replacement";
  };
}

/**
 * Submit exactly one restart for the separately configured Render background
 * worker. The signed command and its immutable Voice Lab receipt are durable
 * before the POST. After the POST, this function performs GET/observation
 * polling only; it never retries the provider mutation.
 */
export async function executeD02RenderWorkerTermination(input: {
  controller: D02RenderWorkerTerminationInput;
  renderBearer: string;
  publicConfig: PublicAuthorityConfig;
  transportTokens: TransportTokens;
  deploymentPrivateKeyPath: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  allowHttpForTest?: boolean;
  checkpoint?: (checkpoint: D02WorkerTerminationCheckpoint) => Promise<void>;
  resumeCheckpoints?: readonly unknown[];
}): Promise<D02RenderWorkerTerminationResult> {
  const controller = D02RenderWorkerTerminationInputSchema.parse(input.controller);
  if (Buffer.byteLength(input.renderBearer) < 32) throw new Error("Render controller bearer credential is invalid.");
  if (!input.checkpoint) throw new Error("D02 worker termination requires a durable immutable checkpoint journal before any network activity.");
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = input.now ?? (() => new Date());
  const resume = parseResumeCheckpoints(input.resumeCheckpoints ?? []);
  assertStaticResumeBindings(resume, controller, input.publicConfig);

  let preflight = resume.preflight;
  if (!preflight) {
    const beforeSnapshot = await readRenderWorkerSnapshot(controller, input.renderBearer, fetchImpl, null);
    assertAuthorizedLiveSnapshot(beforeSnapshot, controller);
    const terminationRequestId = randomUUID();
    const commandRequestedAt = now();
    preflight = {
      phase: "preflight_prepared",
      termination_request_id: terminationRequestId,
      command_requested_at: commandRequestedAt.toISOString(),
      action_request_sha256: renderActionRequestHash(controller.render_worker_service_id, terminationRequestId),
      before_worker_owner_instance_id_sha256: controller.browser.worker_id_sha256,
      before_worker_owner_membership_count: 1,
      before: snapshotToRecord(beforeSnapshot),
    };
    await input.checkpoint(preflight);
  }
  const before = snapshotFromRecord(preflight.before);
  const terminationRequestId = preflight.termination_request_id;
  const commandRequestedAt = new Date(preflight.command_requested_at);
  const actionRequestSha256 = preflight.action_request_sha256;
  const commandEvidence = commandEvidenceFor(controller, preflight);

  let commandClaim = resume.commandClaim;
  if (!commandClaim) {
    commandClaim = await signExternalClaim(newUnsignedClaim({ run: controller.run, authority: "deployment_control", publicConfig: input.publicConfig, evidence: commandEvidence, now: commandRequestedAt }), input.publicConfig, input.deploymentPrivateKeyPath, commandRequestedAt);
    await input.checkpoint({ phase: "command_prepared", claim: commandClaim });
  }
  let commandResponses = [...resume.commandResponses];
  let commandReceipt = resume.commandReceipt;
  if (!commandReceipt) {
    commandReceipt = await postAttestationAndVerifyReplay({
      baseUrl: controller.voice_lab_url,
      claim: commandClaim,
      publicConfig: input.publicConfig,
      transportTokens: input.transportTokens,
      fetchImpl,
      ...(input.allowHttpForTest === undefined ? {} : { allowHttpForTest: input.allowHttpForTest }),
      priorResponses: commandResponses,
      retry: attestationRetry(controller, sleep),
      onResponse: async (response) => {
        await input.checkpoint!({ phase: "command_attestation_response", response });
        commandResponses = [...commandResponses, response];
      },
    });
    await input.checkpoint({ phase: "command_attached", receipt: commandReceipt });
  }

  const dispatchWasDurableAtEntry = resume.dispatchIntent !== undefined;
  let dispatchIntent = resume.dispatchIntent;
  if (!dispatchIntent) {
    const requestedAt = now().toISOString();
    const dispatchAttemptId = randomUUID();
    const dispatchClaimRequest = renderDispatchClaimRequest(controller, preflight, commandClaim, commandReceipt, actionRequestSha256, dispatchAttemptId, requestedAt);
    dispatchIntent = { action_request_sha256: actionRequestSha256, dispatch_attempt_id: dispatchAttemptId, dispatch_claim_request_sha256: canonicalRequestHash(dispatchClaimRequest), requested_at: requestedAt };
    await input.checkpoint({ phase: "render_worker_dispatch_intent", receipt: dispatchIntent });
  }
  const actionRequestedAt = new Date(dispatchIntent.requested_at);
  let acceptedReceipt = resume.accepted;
  if (!acceptedReceipt) {
    if (dispatchWasDurableAtEntry) {
      const reconciliation = await reconcileAmbiguousRenderDispatch(controller, before, actionRequestedAt, input.renderBearer, fetchImpl);
      throw new Error(`D02_RENDER_DISPATCH_MANUAL_REQUIRED: durable Render dispatch intent has no accepted response; GET-only reconciliation was ${reconciliation}. The controller will never issue a second Render POST.`);
    }
    const dispatchClaimRequest = renderDispatchClaimRequest(controller, preflight, commandClaim, commandReceipt, actionRequestSha256, dispatchIntent.dispatch_attempt_id, dispatchIntent.requested_at);
    if (canonicalRequestHash(dispatchClaimRequest) !== dispatchIntent.dispatch_claim_request_sha256) throw new Error("D02 Render dispatch claim request drifted after its durable local intent.");
    let dispatchClaim: z.infer<typeof D02RenderWorkerDispatchClaimResponseSchema>;
    try {
      dispatchClaim = await claimGlobalRenderWorkerDispatch(controller.voice_lab_url, input.transportTokens.deployment_control, dispatchClaimRequest, fetchImpl, input.allowHttpForTest === true);
    } catch (error) {
      throw new Error("D02_RENDER_DISPATCH_MANUAL_REQUIRED: the global one-shot Render dispatch claim was rejected or ambiguous; the controller will never issue the Render POST on retry.", { cause: error });
    }
    if (dispatchClaim.idempotent_replay) throw new Error("D02_RENDER_DISPATCH_MANUAL_REQUIRED: the global one-shot Render dispatch was already claimed; this invocation will never issue the Render POST.");
    let accepted: Awaited<ReturnType<typeof renderRequest>>;
    try {
      accepted = await renderRequest({
        url: new URL(`/v1/services/${encodeURIComponent(controller.render_worker_service_id)}/restart`, controller.render_api_origin),
        method: "POST",
        bearer: input.renderBearer,
        fetchImpl,
      });
    } catch (error) {
      throw new Error("D02_RENDER_DISPATCH_MANUAL_REQUIRED: the sole Render POST response was ambiguous; resume is GET-only and will never POST again.", { cause: error });
    }
    const actionAcceptedAt = now();
    if (accepted.status !== 200) throw new Error(`D02_RENDER_DISPATCH_MANUAL_REQUIRED: the sole Render restart returned HTTP ${accepted.status}; the controller will never POST again.`);
    acceptedReceipt = { action_request_sha256: actionRequestSha256, action_accepted_response_sha256: accepted.responseSha256, dispatch_attempt_id_sha256: dispatchClaim.dispatch_attempt_id_sha256, dispatch_claim_sha256: dispatchClaim.dispatch_claim_sha256, dispatch_claim_event_seq: dispatchClaim.event_seq, http_status: 200, requested_at: actionRequestedAt.toISOString(), accepted_at: actionAcceptedAt.toISOString() };
    await input.checkpoint({ phase: "render_worker_restart_accepted", receipt: acceptedReceipt });
  }

  let localControllerReceipt = resume.localReceipt;
  let localControllerReceiptSha256 = resume.localReceiptSha256;
  if (!localControllerReceipt || !localControllerReceiptSha256) {
    const deadline = Date.now() + controller.poll.timeout_ms;
    let after: RenderWorkerSnapshot | null = null;
    while (Date.now() < deadline) {
      const candidate = await readRenderWorkerSnapshot(controller, input.renderBearer, fetchImpl, actionRequestedAt).catch(() => null);
      if (candidate && isSettledReplacement(before, candidate, actionRequestedAt, controller)) { after = candidate; break; }
      await sleep(controller.poll.interval_ms);
    }
    if (!after || after.deploySettledAt === null) throw new Error("Render worker restart did not settle to a live service with a wholly replacement instance set within the bounded deadline.");
    const actionSettledAt = now();
    const actionSettledSnapshotSha256 = settledSnapshotHash(controller, after);

    let lossObservation: D02BrowserWorkerLossObservation | null = null;
    while (Date.now() < deadline) {
      lossObservation = await readWorkerLossObservation({
        baseUrl: controller.voice_lab_url,
        bearer: input.transportTokens.deployment_control,
        runId: controller.run.run_id,
        terminationRequestIdSha256: sha256(terminationRequestId),
        fetchImpl,
        allowHttpForTest: input.allowHttpForTest === true,
      }).catch(() => null);
      if (lossObservation) break;
      await sleep(controller.poll.interval_ms);
    }
    if (!lossObservation) throw new Error("Voice Lab did not produce the exact durable browser-worker loss observation within the bounded controller deadline.");
    assertLossObservation(controller, terminationRequestId, lossObservation, after);

    const issuedAt = now();
    const localUnsigned = {
    schema: "sophia_voice_lab_d02_render_worker_termination_receipt_v1" as const,
    receipt_id: terminationRequestId,
    termination_request_id: terminationRequestId,
    run_id: controller.run.run_id,
    test_run_id_sha256: controller.run.test_run_id_sha256,
    cleanup_obligation_id_sha256: controller.run.cleanup_obligation_id_sha256,
    environment: controller.run.environment,
    expected_deployment: controller.run.expected_deployment,
    authority: "deployment_control" as const,
    issuer: input.publicConfig.deployment_control.issuer,
    subject: input.publicConfig.deployment_control.subject,
    authority_key_id: input.publicConfig.deployment_control.key_id,
    audience: "sophia-voice-lab-browser-worker-termination-receipt" as const,
    binding: {
      worker_service_id_sha256: sha256(controller.render_worker_service_id),
      provider_session_id_sha256: controller.provider.session_id_sha256,
      provider_admission_id_sha256: controller.provider.admission_id_sha256,
      provider_connection_epoch: controller.provider.connection_epoch,
      frozen_provider_connection_epochs: controller.provider.frozen_connection_epochs,
      browser_worker_id_sha256: controller.browser.worker_id_sha256,
      browser_lease_epoch: controller.browser.lease_epoch,
      browser_context_id_sha256: controller.browser.context_id_sha256,
    },
    render: {
      before_service_response_sha256: before.serviceResponseSha256,
      after_service_response_sha256: after.serviceResponseSha256,
      before_deploy_id_sha256: sha256(before.deployId),
      after_deploy_id_sha256: sha256(after.deployId),
      before_deploy_response_sha256: before.deployResponseSha256,
      after_deploy_response_sha256: after.deployResponseSha256,
      before_instance_response_sha256: before.instanceResponseSha256,
      after_instance_response_sha256: after.instanceResponseSha256,
      before_instance_set_sha256: before.instanceSetSha256,
      after_instance_set_sha256: after.instanceSetSha256,
      before_worker_owner_instance_id_sha256: controller.browser.worker_id_sha256,
      before_worker_owner_membership_count: 1 as const,
      replacement_worker_owner_instance_id_sha256: lossObservation.replacement_browser_worker_id_sha256,
      replacement_worker_owner_membership_count: 1 as const,
      lost_worker_present_before_restart: true as const,
      lost_worker_absent_after_restart: true as const,
      dispatch_attempt_id_sha256: acceptedReceipt.dispatch_attempt_id_sha256,
      dispatch_claim_sha256: acceptedReceipt.dispatch_claim_sha256,
      dispatch_claim_event_seq: acceptedReceipt.dispatch_claim_event_seq,
      action_request_sha256: actionRequestSha256,
      action_accepted_response_sha256: acceptedReceipt.action_accepted_response_sha256,
      action_settled_snapshot_sha256: actionSettledSnapshotSha256,
      action_http_status: 200 as const,
      action_requested_at: actionRequestedAt.toISOString(),
      action_accepted_at: acceptedReceipt.accepted_at,
      action_settled_at: actionSettledAt.toISOString(),
      old_worker_instances_absent: true as const,
      replacement_worker_instances_observed: true as const,
      action_state: "settled_live_replacement" as const,
    },
    voice_lab: { worker_loss_observation: lossObservation },
    gateway: { settlement_schema_status: "not_yet_included" as const, settlement_receipt_included: false as const },
    nonce: randomBytes(32).toString("base64url"),
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 900_000).toISOString(),
    signature_algorithm: "ed25519-sha256-canonical-request-v1" as const,
    };
    localControllerReceipt = await signD02WorkerTerminationReceipt(localUnsigned, input.publicConfig, input.deploymentPrivateKeyPath);
    D02WorkerTerminationControllerReceiptSchema.parse(localControllerReceipt);
    localControllerReceiptSha256 = canonicalRequestHash(localControllerReceipt);
    await input.checkpoint({ phase: "render_worker_replacement_settled", receipt: localControllerReceipt, receipt_sha256: localControllerReceiptSha256 });
  }

  const finalEvidence = finalEvidenceFor(controller, preflight, dispatchIntent, localControllerReceipt, localControllerReceiptSha256);
  let finalClaim = resume.finalClaim;
  if (!finalClaim) {
    const finalNow = now();
    finalClaim = await signExternalClaim(newUnsignedClaim({ run: controller.run, authority: "deployment_control", publicConfig: input.publicConfig, evidence: finalEvidence, now: finalNow }), input.publicConfig, input.deploymentPrivateKeyPath, finalNow);
    await input.checkpoint({ phase: "final_prepared", claim: finalClaim });
  }
  let finalResponses = [...resume.finalResponses];
  let finalReceipt = resume.finalReceipt;
  if (!finalReceipt) {
    finalReceipt = await postAttestationAndVerifyReplay({
      baseUrl: controller.voice_lab_url,
      claim: finalClaim,
      publicConfig: input.publicConfig,
      transportTokens: input.transportTokens,
      fetchImpl,
      ...(input.allowHttpForTest === undefined ? {} : { allowHttpForTest: input.allowHttpForTest }),
      priorResponses: finalResponses,
      retry: attestationRetry(controller, sleep),
      onResponse: async (response) => {
        await input.checkpoint!({ phase: "final_attestation_response", response });
        finalResponses = [...finalResponses, response];
      },
    });
    await input.checkpoint({ phase: "final_attached", receipt: finalReceipt });
  }
  return {
    command_claim: commandClaim,
    command_receipt: commandReceipt,
    local_controller_receipt: localControllerReceipt,
    local_controller_receipt_sha256: localControllerReceiptSha256,
    final_claim: finalClaim,
    final_receipt: finalReceipt,
    provider_action: {
      worker_service_id_sha256: sha256(controller.render_worker_service_id),
      action_request_sha256: actionRequestSha256,
      action_accepted_response_sha256: localControllerReceipt.render.action_accepted_response_sha256,
      action_settled_snapshot_sha256: localControllerReceipt.render.action_settled_snapshot_sha256,
      before_instance_set_sha256: localControllerReceipt.render.before_instance_set_sha256,
      after_instance_set_sha256: localControllerReceipt.render.after_instance_set_sha256,
      state: "settled_live_replacement",
    },
  };
}

function parseResumeCheckpoints(raw: readonly unknown[]): ResumeState {
  const parsed = raw.map((value) => D02WorkerTerminationCheckpointSchema.parse(value));
  const expected: Array<{ phase: D02WorkerTerminationCheckpoint["phase"]; ordinal?: 1 | 2 }> = [
    { phase: "preflight_prepared" },
    { phase: "command_prepared" },
    { phase: "command_attestation_response", ordinal: 1 },
    { phase: "command_attestation_response", ordinal: 2 },
    { phase: "command_attached" },
    { phase: "render_worker_dispatch_intent" },
    { phase: "render_worker_restart_accepted" },
    { phase: "render_worker_replacement_settled" },
    { phase: "final_prepared" },
    { phase: "final_attestation_response", ordinal: 1 },
    { phase: "final_attestation_response", ordinal: 2 },
    { phase: "final_attached" },
  ];
  if (parsed.length > expected.length) throw new Error("D02 resume journal contains phases beyond the terminal checkpoint.");
  parsed.forEach((checkpoint, index) => {
    const wanted = expected[index]!;
    const ordinal = "response" in checkpoint ? checkpoint.response.ordinal : undefined;
    if (checkpoint.phase !== wanted.phase || (wanted.ordinal !== undefined && ordinal !== wanted.ordinal)) throw new Error(`D02 resume journal is gapped, reordered, or contains a non-canonical phase at position ${index + 1}.`);
  });
  const state: ResumeState = { commandResponses: [], finalResponses: [] };
  for (const checkpoint of parsed) {
    if (checkpoint.phase === "preflight_prepared") state.preflight = checkpoint;
    else if (checkpoint.phase === "command_prepared") state.commandClaim = checkpoint.claim;
    else if (checkpoint.phase === "command_attestation_response") state.commandResponses.push(checkpoint.response);
    else if (checkpoint.phase === "command_attached") state.commandReceipt = checkpoint.receipt;
    else if (checkpoint.phase === "render_worker_dispatch_intent") state.dispatchIntent = checkpoint.receipt;
    else if (checkpoint.phase === "render_worker_restart_accepted") state.accepted = checkpoint.receipt;
    else if (checkpoint.phase === "render_worker_replacement_settled") { state.localReceipt = checkpoint.receipt; state.localReceiptSha256 = checkpoint.receipt_sha256; }
    else if (checkpoint.phase === "final_prepared") state.finalClaim = checkpoint.claim;
    else if (checkpoint.phase === "final_attestation_response") state.finalResponses.push(checkpoint.response);
    else state.finalReceipt = checkpoint.receipt;
  }
  return state;
}

function assertStaticResumeBindings(resume: ResumeState, controller: D02RenderWorkerTerminationInput, publicConfig: PublicAuthorityConfig): void {
  const preflight = resume.preflight;
  if (!preflight) return;
  const before = snapshotFromRecord(preflight.before);
  assertAuthorizedLiveSnapshot(before, controller);
  if (preflight.action_request_sha256 !== renderActionRequestHash(controller.render_worker_service_id, preflight.termination_request_id)
    || preflight.before_worker_owner_instance_id_sha256 !== controller.browser.worker_id_sha256 || preflight.before_worker_owner_membership_count !== 1) throw new Error("D02 resume preflight action hash or exact Render-owner membership does not bind its stable termination request ID.");

  if (resume.commandClaim) {
    assertClaimEnvelope(resume.commandClaim, controller, publicConfig);
    if (canonicalRequestHash(resume.commandClaim.evidence) !== canonicalRequestHash(commandEvidenceFor(controller, preflight))) throw new Error("D02 resume command claim does not exactly bind the durable preflight and termination request ID.");
    assertAttestationProgress(resume.commandClaim, resume.commandResponses, resume.commandReceipt);
  }
  if (resume.dispatchIntent) {
    if (!resume.commandReceipt || resume.dispatchIntent.action_request_sha256 !== preflight.action_request_sha256
      || canonicalRequestHash(renderDispatchClaimRequest(controller, preflight, resume.commandClaim!, resume.commandReceipt, preflight.action_request_sha256, resume.dispatchIntent.dispatch_attempt_id, resume.dispatchIntent.requested_at)) !== resume.dispatchIntent.dispatch_claim_request_sha256
      || new Date(resume.dispatchIntent.requested_at).getTime() < new Date(preflight.command_requested_at).getTime()) throw new Error("D02 resume Render dispatch intent does not bind the completed command phase.");
  }
  if (resume.accepted) {
    if (!resume.dispatchIntent || resume.accepted.action_request_sha256 !== resume.dispatchIntent.action_request_sha256
      || resume.accepted.requested_at !== resume.dispatchIntent.requested_at
      || resume.accepted.dispatch_attempt_id_sha256 !== sha256(resume.dispatchIntent.dispatch_attempt_id)
      || new Date(resume.accepted.accepted_at).getTime() < new Date(resume.accepted.requested_at).getTime()) throw new Error("D02 resume Render acceptance receipt does not bind the immutable dispatch intent.");
  }
  if (resume.localReceipt) {
    if (!resume.accepted || !resume.localReceiptSha256) throw new Error("D02 resume provider receipt is missing its accepted-action prefix or content hash.");
    verifyD02WorkerTerminationReceipt(resume.localReceipt, publicConfig);
    if (canonicalRequestHash(resume.localReceipt) !== resume.localReceiptSha256) throw new Error("D02 resume provider receipt content hash was tampered.");
    assertLocalReceiptBindings(controller, preflight, resume.accepted, resume.localReceipt);
  }
  if (resume.finalClaim) {
    if (!resume.dispatchIntent || !resume.localReceipt || !resume.localReceiptSha256) throw new Error("D02 resume final claim is missing its durable provider-evidence prefix.");
    assertClaimEnvelope(resume.finalClaim, controller, publicConfig);
    const expected = finalEvidenceFor(controller, preflight, resume.dispatchIntent, resume.localReceipt, resume.localReceiptSha256);
    if (canonicalRequestHash(resume.finalClaim.evidence) !== canonicalRequestHash(expected)) throw new Error("D02 resume final claim does not exactly bind the durable provider receipt and loss evidence.");
    assertAttestationProgress(resume.finalClaim, resume.finalResponses, resume.finalReceipt);
  }
}

function assertClaimEnvelope(claim: SignedExternalAttestation, controller: D02RenderWorkerTerminationInput, publicConfig: PublicAuthorityConfig): void {
  verifyPersistedExternalClaimSignature(claim, publicConfig);
  if (claim.run_id !== controller.run.run_id || claim.test_run_id_sha256 !== controller.run.test_run_id_sha256
    || claim.cleanup_obligation_id_sha256 !== controller.run.cleanup_obligation_id_sha256 || claim.scenario_id !== controller.run.scenario_id
    || claim.scenario_version !== controller.run.scenario_version || claim.environment !== controller.run.environment
    || canonicalRequestHash(claim.expected_deployment) !== canonicalRequestHash(controller.run.expected_deployment)) throw new Error("D02 resume signed claim does not bind the exact controller input and deployment.");
}

function assertAttestationProgress(claim: SignedExternalAttestation, responses: readonly AttestationResponseCheckpoint[], receipt: VerifiedAttestationReceipt | undefined): void {
  if (responses.some((response, index) => response.ordinal !== index + 1)) throw new Error("D02 resume attestation responses are not one exact contiguous prefix.");
  for (const response of responses) {
    const envelope = response.envelope;
    if (envelope.run_id !== claim.run_id || envelope.data.attestation_id !== claim.attestation_id || envelope.data.attestation_kind !== claim.evidence.kind
      || envelope.event_cursor < envelope.data.event_seq || canonicalRequestHash(envelope.deployment_identity.expected) !== canonicalRequestHash(claim.expected_deployment)
      || (response.ordinal === 2 && envelope.data.replay !== true)) throw new Error("D02 resume attestation response does not bind the exact signed claim and immutable replay.");
  }
  if (responses.length === 2 && (responses[0]!.envelope.data.event_seq !== responses[1]!.envelope.data.event_seq
    || responses[0]!.envelope.data.content_sha256 !== responses[1]!.envelope.data.content_sha256)) throw new Error("D02 resume attestation response pair does not resolve to one immutable event.");
  if (receipt) {
    if (responses.length !== 2) throw new Error("D02 resume verified receipt is missing one of its response checkpoints.");
    const expected = VerifiedAttestationReceiptSchema.parse({
      first_response_sha256: responses[0]!.response_sha256,
      replay_response_sha256: responses[1]!.response_sha256,
      attestation_id: claim.attestation_id,
      attestation_kind: claim.evidence.kind,
      content_sha256: responses[0]!.envelope.data.content_sha256,
      event_seq: responses[0]!.envelope.data.event_seq,
      event_cursor: Math.max(responses[0]!.envelope.event_cursor, responses[1]!.envelope.event_cursor),
      immutable: true,
      exact_replay_verified: true,
    });
    if (canonicalRequestHash(receipt) !== canonicalRequestHash(expected)) throw new Error("D02 resume verified attestation receipt was tampered or detached from its response checkpoints.");
  }
}

function assertLocalReceiptBindings(
  controller: D02RenderWorkerTerminationInput,
  preflight: Extract<D02WorkerTerminationCheckpoint, { phase: "preflight_prepared" }>,
  accepted: Extract<D02WorkerTerminationCheckpoint, { phase: "render_worker_restart_accepted" }>["receipt"],
  receipt: D02WorkerTerminationControllerReceipt,
): void {
  const before = preflight.before;
  if (receipt.termination_request_id !== preflight.termination_request_id || receipt.run_id !== controller.run.run_id
    || receipt.test_run_id_sha256 !== controller.run.test_run_id_sha256 || receipt.cleanup_obligation_id_sha256 !== controller.run.cleanup_obligation_id_sha256
    || receipt.environment !== controller.run.environment || canonicalRequestHash(receipt.expected_deployment) !== canonicalRequestHash(controller.run.expected_deployment)
    || receipt.binding.worker_service_id_sha256 !== sha256(controller.render_worker_service_id)
    || receipt.binding.provider_session_id_sha256 !== controller.provider.session_id_sha256 || receipt.binding.provider_admission_id_sha256 !== controller.provider.admission_id_sha256
    || receipt.binding.provider_connection_epoch !== controller.provider.connection_epoch || canonicalRequestHash(receipt.binding.frozen_provider_connection_epochs) !== canonicalRequestHash(controller.provider.frozen_connection_epochs)
    || receipt.binding.browser_worker_id_sha256 !== controller.browser.worker_id_sha256 || receipt.binding.browser_lease_epoch !== controller.browser.lease_epoch
    || receipt.binding.browser_context_id_sha256 !== controller.browser.context_id_sha256 || receipt.render.before_service_response_sha256 !== before.service_response_sha256
    || receipt.render.before_deploy_id_sha256 !== sha256(before.deploy_id) || receipt.render.before_deploy_response_sha256 !== before.deploy_response_sha256
    || receipt.render.before_instance_response_sha256 !== before.instance_response_sha256 || receipt.render.before_instance_set_sha256 !== before.instance_set_sha256
    || receipt.render.before_worker_owner_instance_id_sha256 !== preflight.before_worker_owner_instance_id_sha256 || receipt.render.before_worker_owner_membership_count !== 1
    || receipt.render.replacement_worker_owner_instance_id_sha256 !== receipt.voice_lab.worker_loss_observation.replacement_browser_worker_id_sha256
    || receipt.render.replacement_worker_owner_membership_count !== 1
    || receipt.render.lost_worker_present_before_restart !== true || receipt.render.lost_worker_absent_after_restart !== true
    || receipt.render.dispatch_attempt_id_sha256 !== accepted.dispatch_attempt_id_sha256 || receipt.render.dispatch_claim_sha256 !== accepted.dispatch_claim_sha256
    || receipt.render.dispatch_claim_event_seq !== accepted.dispatch_claim_event_seq
    || receipt.render.action_request_sha256 !== preflight.action_request_sha256 || receipt.render.action_accepted_response_sha256 !== accepted.action_accepted_response_sha256
    || receipt.render.action_requested_at !== accepted.requested_at || receipt.render.action_accepted_at !== accepted.accepted_at) throw new Error("D02 resume provider receipt does not bind the exact controller, preflight, and accepted Render response.");
  assertLossObservation(controller, preflight.termination_request_id, receipt.voice_lab.worker_loss_observation);
}

function commandEvidenceFor(controller: D02RenderWorkerTerminationInput, preflight: Extract<D02WorkerTerminationCheckpoint, { phase: "preflight_prepared" }>) {
  return {
    kind: "d02_browser_worker_termination_command" as const,
    authority: "deployment_control" as const,
    termination_request_id: preflight.termination_request_id,
    run_id_sha256: sha256(controller.run.run_id),
    cleanup_obligation_id_sha256: controller.run.cleanup_obligation_id_sha256,
    worker_service_id_sha256: sha256(controller.render_worker_service_id),
    provider_session_id_sha256: controller.provider.session_id_sha256,
    provider_admission_id_sha256: controller.provider.admission_id_sha256,
    provider_connection_epoch: controller.provider.connection_epoch,
    frozen_provider_connection_epochs: controller.provider.frozen_connection_epochs,
    browser_worker_id_sha256: controller.browser.worker_id_sha256,
    browser_lease_epoch: controller.browser.lease_epoch,
    browser_context_id_sha256: controller.browser.context_id_sha256,
    before_worker_deploy_id_sha256: sha256(preflight.before.deploy_id),
    before_worker_instance_set_sha256: preflight.before.instance_set_sha256,
    before_worker_owner_instance_id_sha256: preflight.before_worker_owner_instance_id_sha256,
    before_worker_owner_membership_count: preflight.before_worker_owner_membership_count,
    render_action_request_sha256: preflight.action_request_sha256,
    requested_at: preflight.command_requested_at,
    target_service: "sophia-voice-lab-worker" as const,
    termination_mode: "render_service_restart_one_shot" as const,
    worker_mutation_authorized: true as const,
    product_mutation_authorized: false as const,
    one_shot: true as const,
  };
}

function finalEvidenceFor(
  controller: D02RenderWorkerTerminationInput,
  preflight: Extract<D02WorkerTerminationCheckpoint, { phase: "preflight_prepared" }>,
  dispatch: Extract<D02WorkerTerminationCheckpoint, { phase: "render_worker_dispatch_intent" }>["receipt"],
  localReceipt: D02WorkerTerminationControllerReceipt,
  localReceiptSha256: string,
) {
  const loss = localReceipt.voice_lab.worker_loss_observation;
  return {
    kind: "d02_browser_worker_loss" as const,
    authority: "deployment_control" as const,
    termination_request_id_sha256: sha256(preflight.termination_request_id),
    local_controller_receipt_sha256: localReceiptSha256,
    run_id_sha256: sha256(controller.run.run_id),
    cleanup_obligation_id_sha256: controller.run.cleanup_obligation_id_sha256,
    worker_service_id_sha256: sha256(controller.render_worker_service_id),
    provider_session_id_sha256: controller.provider.session_id_sha256,
    provider_admission_id_sha256: controller.provider.admission_id_sha256,
    provider_connection_epoch: controller.provider.connection_epoch,
    frozen_provider_connection_epochs: controller.provider.frozen_connection_epochs,
    product_provider_cleanup_settlement_sha256: loss.product_provider_cleanup_settlement_sha256,
    browser_context_id_sha256: controller.browser.context_id_sha256,
    lost_worker_id_sha256: loss.lost_browser_worker_id_sha256,
    replacement_worker_id_sha256: loss.replacement_browser_worker_id_sha256,
    lost_browser_lease_epoch: loss.lost_browser_lease_epoch,
    loss_event_seq: loss.loss_event_seq,
    loss_observed_at: loss.loss_observed_at,
    render_action_request_sha256: preflight.action_request_sha256,
    render_action_accepted_response_sha256: localReceipt.render.action_accepted_response_sha256,
    render_action_settled_snapshot_sha256: localReceipt.render.action_settled_snapshot_sha256,
    before_service_response_sha256: localReceipt.render.before_service_response_sha256,
    after_service_response_sha256: localReceipt.render.after_service_response_sha256,
    before_deploy_id_sha256: localReceipt.render.before_deploy_id_sha256,
    after_deploy_id_sha256: localReceipt.render.after_deploy_id_sha256,
    before_instance_set_sha256: localReceipt.render.before_instance_set_sha256,
    after_instance_set_sha256: localReceipt.render.after_instance_set_sha256,
    lost_worker_owner_instance_id_sha256: preflight.before_worker_owner_instance_id_sha256,
    lost_worker_present_before_restart: true as const,
    lost_worker_absent_after_restart: true as const,
    replacement_worker_owner_instance_id_sha256: localReceipt.render.replacement_worker_owner_instance_id_sha256,
    replacement_worker_owner_membership_count: localReceipt.render.replacement_worker_owner_membership_count,
    render_dispatch_claim_sha256: localReceipt.render.dispatch_claim_sha256,
    command_requested_at: preflight.command_requested_at,
    action_requested_at: dispatch.requested_at,
    action_accepted_at: localReceipt.render.action_accepted_at,
    action_settled_at: localReceipt.render.action_settled_at,
    action_kind: "render_worker_service_restart" as const,
    restart_http_status: 200 as const,
    old_worker_instances_absent: true as const,
    replacement_worker_instances_observed: true as const,
    gateway_settlement_receipt_included: false as const,
  };
}

function renderActionRequestHash(serviceId: string, terminationRequestId: string): string {
  return canonicalRequestHash({
    method: "POST",
    provider: "render",
    action: "restart",
    path_sha256: sha256(`/v1/services/${serviceId}/restart`),
    body_sha256: sha256(Buffer.alloc(0)),
    termination_request_id_sha256: sha256(terminationRequestId),
  });
}

function renderDispatchClaimRequest(
  controller: D02RenderWorkerTerminationInput,
  preflight: Extract<D02WorkerTerminationCheckpoint, { phase: "preflight_prepared" }>,
  commandClaim: SignedExternalAttestation,
  commandReceipt: VerifiedAttestationReceipt,
  actionRequestSha256: string,
  dispatchAttemptId: string,
  requestedAt: string,
) {
  return {
    schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_request_v1" as const,
    run_id: controller.run.run_id,
    termination_request_id: preflight.termination_request_id,
    command_attestation_id: commandClaim.attestation_id,
    command_content_sha256: commandReceipt.content_sha256,
    command_event_seq: commandReceipt.event_seq,
    worker_service_id_sha256: sha256(controller.render_worker_service_id),
    action_request_sha256: actionRequestSha256,
    dispatch_attempt_id: dispatchAttemptId,
    requested_at: requestedAt,
  };
}

async function claimGlobalRenderWorkerDispatch(
  baseUrl: string,
  bearer: string,
  request: ReturnType<typeof renderDispatchClaimRequest>,
  fetchImpl: typeof fetch,
  allowHttpForTest: boolean,
): Promise<z.infer<typeof D02RenderWorkerDispatchClaimResponseSchema>> {
  const url = exactVoiceLabEndpoint(baseUrl, "/internal/voice-lab/d02/render-worker-dispatch-claims", allowHttpForTest);
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await readProviderResponse(response);
  if (response.status !== 200 && response.status !== 201) throw new Error(`Global D02 Render dispatch claim returned HTTP ${response.status}.`);
  const claim = D02RenderWorkerDispatchClaimResponseSchema.parse(body.parsed);
  const expectedCore = {
    schema: "sophia_voice_lab_d02_render_worker_dispatch_claim_v1" as const,
    termination_request_id_sha256: sha256(request.termination_request_id),
    command_attestation_id_sha256: sha256(request.command_attestation_id),
    command_content_sha256: request.command_content_sha256,
    command_event_seq: request.command_event_seq,
    worker_service_id_sha256: request.worker_service_id_sha256,
    action_request_sha256: request.action_request_sha256,
    dispatch_attempt_id_sha256: sha256(request.dispatch_attempt_id),
    requested_at: request.requested_at,
    raw_action_and_attempt_identifiers_excluded: true as const,
  };
  if (claim.termination_request_id_sha256 !== sha256(request.termination_request_id)
    || claim.dispatch_attempt_id_sha256 !== sha256(request.dispatch_attempt_id)
    || claim.action_request_sha256 !== request.action_request_sha256
    || claim.dispatch_claim_sha256 !== canonicalRequestHash(expectedCore)
    || claim.event_seq <= request.command_event_seq
    || claim.idempotent_replay !== (response.status === 200)
    || claim.claimed_at !== request.requested_at) {
    throw new Error("Global D02 Render dispatch claim did not bind the exact local intent and response status.");
  }
  return claim;
}

function snapshotToRecord(snapshot: RenderWorkerSnapshot): z.infer<typeof RenderWorkerSnapshotRecordSchema> {
  return RenderWorkerSnapshotRecordSchema.parse({
    service_id: snapshot.serviceId,
    service_name: snapshot.serviceName,
    service_type: snapshot.serviceType,
    service_response_sha256: snapshot.serviceResponseSha256,
    deploy_response_sha256: snapshot.deployResponseSha256,
    instance_response_sha256: snapshot.instanceResponseSha256,
    deploy_id: snapshot.deployId,
    deploy_status: snapshot.deployStatus,
    deploy_started_at: snapshot.deployStartedAt,
    deploy_settled_at: snapshot.deploySettledAt,
    instance_ids: snapshot.instanceIds,
    instance_created_at: snapshot.instanceCreatedAt.map((value) => value.toISOString()),
    instance_set_sha256: snapshot.instanceSetSha256,
  });
}

function snapshotFromRecord(record: z.infer<typeof RenderWorkerSnapshotRecordSchema>): RenderWorkerSnapshot {
  const parsed = RenderWorkerSnapshotRecordSchema.parse(record);
  return {
    serviceId: parsed.service_id,
    serviceName: parsed.service_name,
    serviceType: parsed.service_type,
    serviceResponseSha256: parsed.service_response_sha256,
    deployResponseSha256: parsed.deploy_response_sha256,
    instanceResponseSha256: parsed.instance_response_sha256,
    deployId: parsed.deploy_id,
    deployStatus: parsed.deploy_status,
    deployStartedAt: parsed.deploy_started_at,
    deploySettledAt: parsed.deploy_settled_at,
    instanceIds: parsed.instance_ids,
    instanceCreatedAt: parsed.instance_created_at.map((value) => new Date(value)),
    instanceSetSha256: parsed.instance_set_sha256,
  };
}

function assertAuthorizedLiveSnapshot(snapshot: RenderWorkerSnapshot, controller: D02RenderWorkerTerminationInput): void {
  if (snapshot.serviceId !== controller.render_worker_service_id || snapshot.serviceName !== "sophia-voice-lab-worker" || snapshot.serviceType !== "background_worker") throw new Error("Render preflight did not return the exact authorized Sophia Voice Lab background-worker service.");
  if (snapshot.deployStatus !== "live" || snapshot.deploySettledAt === null || snapshot.instanceIds.length < 1) throw new Error("Render worker has no exact live deploy and instance set before the governed action.");
  const ownerMembershipCount = snapshot.instanceIds.filter((instanceId) => sha256(instanceId) === controller.browser.worker_id_sha256).length;
  if (snapshot.instanceIds.length !== 1 || ownerMembershipCount !== 1) throw new Error("Render preflight must contain the exact singleton instance owned by the governed browser worker.");
}

function isSettledReplacement(before: RenderWorkerSnapshot, candidate: RenderWorkerSnapshot, actionRequestedAt: Date, controller: D02RenderWorkerTerminationInput): boolean {
  const oldInstancesAbsent = before.instanceIds.every((id) => !candidate.instanceIds.includes(id));
  const ownerAfterCount = candidate.instanceIds.filter((id) => sha256(id) === controller.browser.worker_id_sha256).length;
  const replacementInstancesObserved = candidate.instanceIds.length > 0
    && candidate.instanceIds.every((id) => !before.instanceIds.includes(id))
    && candidate.instanceCreatedAt.every((createdAt) => createdAt >= actionRequestedAt)
    && ownerAfterCount === 0;
  return candidate.serviceId === before.serviceId && candidate.serviceName === "sophia-voice-lab-worker" && candidate.serviceType === "background_worker"
    && oldInstancesAbsent && replacementInstancesObserved && candidate.deployStatus === "live" && candidate.deploySettledAt !== null;
}

function settledSnapshotHash(controller: D02RenderWorkerTerminationInput, after: RenderWorkerSnapshot): string {
  return canonicalRequestHash({
    worker_service_id_sha256: sha256(controller.render_worker_service_id),
    service_response_sha256: after.serviceResponseSha256,
    deploy_response_sha256: after.deployResponseSha256,
    instance_response_sha256: after.instanceResponseSha256,
    deploy_id_sha256: sha256(after.deployId),
    deploy_status: after.deployStatus,
    deploy_settled_at: after.deploySettledAt,
    instance_set_sha256: after.instanceSetSha256,
  });
}

async function reconcileAmbiguousRenderDispatch(
  controller: D02RenderWorkerTerminationInput,
  before: RenderWorkerSnapshot,
  actionRequestedAt: Date,
  bearer: string,
  fetchImpl: typeof fetch,
): Promise<"replacement_observed_but_acceptance_receipt_unavailable" | "inconclusive"> {
  const candidate = await readRenderWorkerSnapshot(controller, bearer, fetchImpl, actionRequestedAt).catch(() => null);
  return candidate && isSettledReplacement(before, candidate, actionRequestedAt, controller) ? "replacement_observed_but_acceptance_receipt_unavailable" : "inconclusive";
}

function attestationRetry(controller: D02RenderWorkerTerminationInput, sleep: (milliseconds: number) => Promise<void>) {
  return {
    maxAttempts: Math.min(1_024, Math.ceil(controller.poll.timeout_ms / controller.poll.interval_ms) + 2),
    intervalMs: controller.poll.interval_ms,
    sleep,
  };
}

function assertLossObservation(controller: D02RenderWorkerTerminationInput, terminationRequestId: string, proof: D02BrowserWorkerLossObservation, replacement?: RenderWorkerSnapshot): void {
  const replacementOwnerMembershipCount = replacement?.instanceIds.filter((instanceId) => sha256(instanceId) === proof.replacement_browser_worker_id_sha256).length;
  if (proof.run_id_sha256 !== sha256(controller.run.run_id) || proof.test_run_id_sha256 !== controller.run.test_run_id_sha256
    || proof.cleanup_obligation_id_sha256 !== controller.run.cleanup_obligation_id_sha256 || proof.termination_request_id_sha256 !== sha256(terminationRequestId)
    || proof.provider_session_id_sha256 !== controller.provider.session_id_sha256 || proof.provider_admission_id_sha256 !== controller.provider.admission_id_sha256
    || proof.provider_connection_epoch !== controller.provider.connection_epoch || canonicalRequestHash(proof.frozen_provider_connection_epochs) !== canonicalRequestHash(controller.provider.frozen_connection_epochs)
    || proof.browser_context_id_sha256 !== controller.browser.context_id_sha256 || proof.lost_browser_worker_id_sha256 !== controller.browser.worker_id_sha256
    || proof.lost_browser_lease_epoch !== controller.browser.lease_epoch || proof.replacement_browser_worker_id_sha256 === controller.browser.worker_id_sha256
    || (replacement !== undefined && (replacement.instanceIds.length !== 1 || replacementOwnerMembershipCount !== 1))
    || proof.browser_lease_absent !== true || proof.owning_gateway_settlement_included !== false) {
    throw new Error("Voice Lab worker-loss observation did not bind the exact governed run/provider/admission/browser/lease/epoch command.");
  }
}

async function readWorkerLossObservation(input: { baseUrl: string; bearer: string; runId: string; terminationRequestIdSha256: string; fetchImpl: typeof fetch; allowHttpForTest: boolean }): Promise<D02BrowserWorkerLossObservation> {
  const url = exactVoiceLabEndpoint(input.baseUrl, "/internal/voice-lab/d02/browser-worker-loss-observation", input.allowHttpForTest);
  const response = await input.fetchImpl(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: input.runId, termination_request_id_sha256: input.terminationRequestIdSha256 }),
  });
  const body = await readProviderResponse(response);
  if (response.status !== 200) throw new Error(`D02 browser-worker loss observation is pending (HTTP ${response.status}).`);
  return D02BrowserWorkerLossObservationSchema.parse(body.parsed);
}

async function readRenderWorkerSnapshot(controller: D02RenderWorkerTerminationInput, bearer: string, fetchImpl: typeof fetch, requestedAfter: Date | null): Promise<RenderWorkerSnapshot> {
  const base = `${controller.render_api_origin}/v1/services/${encodeURIComponent(controller.render_worker_service_id)}`;
  const [service, deploys, instances] = await Promise.all([
    renderRequest({ url: new URL(base), method: "GET", bearer, fetchImpl }),
    renderRequest({ url: new URL(`${base}/deploys?limit=20`), method: "GET", bearer, fetchImpl }),
    renderRequest({ url: new URL(`${base}/instances`), method: "GET", bearer, fetchImpl }),
  ]);
  if (service.status !== 200 || deploys.status !== 200 || instances.status !== 200) throw new Error("Render worker service/deploy/instance preflight failed.");
  const serviceRecord = unwrapNamedRecord(service.parsed, "service");
  const serviceId = String(serviceRecord.id ?? "");
  const serviceName = String(serviceRecord.name ?? "");
  const serviceType = String(serviceRecord.type ?? serviceRecord.serviceType ?? serviceRecord.service_type ?? "");
  if (serviceId !== controller.render_worker_service_id || serviceName !== "sophia-voice-lab-worker" || serviceType !== "background_worker") throw new Error("Render response was not the exact authorized Sophia Voice Lab background-worker service.");
  const deployRecords = unwrapList(deploys.parsed, "deploy").map(normalizeDeploy).filter((value): value is NonNullable<typeof value> => value !== null);
  const threshold = requestedAfter?.getTime() ?? Number.NEGATIVE_INFINITY;
  const deploy = deployRecords.find((value) => value.createdAt.getTime() >= threshold && value.status === "live") ?? deployRecords.find((value) => value.status === "live") ?? null;
  if (!deploy) throw new Error("Render worker deploy list has no exact live deploy record.");
  const instanceRecords = unwrapList(instances.parsed, "instance").map(normalizeInstance).filter((value): value is NonNullable<typeof value> => value !== null);
  const instanceIds = instanceRecords.map((value) => value.id).sort();
  if (instanceIds.length < 1 || new Set(instanceIds).size !== instanceIds.length) throw new Error("Render worker instance set is empty or duplicated.");
  return {
    serviceId,
    serviceName: "sophia-voice-lab-worker",
    serviceType: "background_worker",
    serviceResponseSha256: service.responseSha256,
    deployResponseSha256: deploys.responseSha256,
    instanceResponseSha256: instances.responseSha256,
    deployId: deploy.id,
    deployStatus: deploy.status,
    deployStartedAt: deploy.startedAt.toISOString(),
    deploySettledAt: deploy.finishedAt?.toISOString() ?? (deploy.status === "live" ? deploy.updatedAt.toISOString() : null),
    instanceIds,
    instanceCreatedAt: instanceRecords.map((value) => value.createdAt),
    instanceSetSha256: canonicalRequestHash(instanceIds.map((id) => sha256(id)).sort()),
  };
}

async function renderRequest(input: { url: URL; method: "GET" | "POST"; bearer: string; fetchImpl: typeof fetch }): Promise<{ status: number; responseSha256: string; parsed: unknown }> {
  if (input.url.origin !== "https://api.render.com" || !input.url.pathname.startsWith("/v1/services/") || input.url.username || input.url.password || input.url.hash) throw new Error("Render worker request escaped the exact API/service allowlist.");
  const response = await input.fetchImpl(input.url, { method: input.method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { accept: "application/json", authorization: `Bearer ${input.bearer}` } });
  const body = await readProviderResponse(response);
  return { status: response.status, responseSha256: body.responseSha256, parsed: body.parsed };
}

async function readProviderResponse(response: Response): Promise<{ responseSha256: string; parsed: unknown }> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("Provider response exceeded the controller byte cap.");
  let parsed: unknown = null;
  if (bytes.byteLength > 0) {
    try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { parsed = { non_json_response_sha256: sha256(bytes), byte_length: bytes.byteLength }; }
  }
  return { responseSha256: sha256(bytes), parsed };
}

function exactVoiceLabEndpoint(baseUrl: string, pathname: string, allowHttpForTest: boolean): URL {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(allowHttpForTest && url.protocol === "http:")) throw new Error("D02 worker-loss observation requires HTTPS.");
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Voice Lab controller URL must be a bare origin.");
  url.pathname = pathname;
  return url;
}

function unwrapNamedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Render ${key} response is not an object.`);
  const record = value as Record<string, unknown>;
  const nested = record[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : record;
}

function unwrapList(value: unknown, key: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Render ${key} list response is not an array.`);
  return value.map((item) => unwrapNamedRecord(item, key));
}

function normalizeDeploy(record: Record<string, unknown>): { id: string; status: string; createdAt: Date; startedAt: Date; updatedAt: Date; finishedAt: Date | null } | null {
  const id = String(record.id ?? "");
  const status = String(record.status ?? "");
  if (!/^dep-[0-9a-z]{20}$/.test(id) || !/^[a-z_]+$/.test(status)) return null;
  const createdAt = exactDate(record.createdAt ?? record.created_at);
  const startedAt = exactDate(record.startedAt ?? record.started_at ?? record.createdAt ?? record.created_at);
  const updatedAt = exactDate(record.updatedAt ?? record.updated_at ?? record.finishedAt ?? record.finished_at ?? record.createdAt ?? record.created_at);
  const finishedRaw = record.finishedAt ?? record.finished_at;
  const finishedAt = finishedRaw === null || finishedRaw === undefined ? null : exactDate(finishedRaw);
  return { id, status, createdAt, startedAt, updatedAt, finishedAt };
}

function normalizeInstance(record: Record<string, unknown>): { id: string; createdAt: Date } | null {
  const id = String(record.id ?? record.instanceId ?? record.instance_id ?? "");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return null;
  return { id, createdAt: exactDate(record.createdAt ?? record.created_at) };
}

function exactDate(value: unknown): Date {
  if (typeof value !== "string") throw new Error("Render provider receipt lacks a required timestamp.");
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("Render provider receipt contains an invalid timestamp.");
  return parsed;
}
