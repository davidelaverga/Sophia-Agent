import { z } from "zod";
import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { RecoveryControlBindingSchema, validateRecoveryAllocationBinding, type RecoveryControlRecord } from "../../src/recovery-control.js";
import { parseGenericOwnerDispatch, genericOwnerLossDispatchFromControl } from "../../src/generic-owner-dispatch.js";
import { GenericOwnerLossReceiptSchema, verifyGenericOwnerLoss, parseVerifiedGenericOwnerLoss, type GenericOwnerLossReceipt } from "../../src/generic-owner-loss.js";
import { readGenericWorkerPreflight, readGenericWorkerReplacementPreflight, genericRecoveryOrigin, RecoveryProductDeploymentSchema } from "./generic-worker-preflight.js";
import { readRenderWorkerSnapshot } from "./render-worker-controller.js";
import { retryableRenderObservation } from "./render-inventory.js";
import { signGenericOwnerLossReceipt, validateGenericOwnerSigningCustody } from "./crypto.js";
import type { PublicAuthorityConfig } from "./contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime();
const preparedSchema = z.object({
  requestId: z.string().uuid(), controlBindingSha256: hash, allocationBindingSha256: hash, workerServiceIdSha256: hash,
  expectedLabSha: z.string().regex(/^[a-f0-9]{40}$/), expectedLangGraphSha: z.string().regex(/^[a-f0-9]{40}$/),
  expectedRecoveryDeployment: RecoveryProductDeploymentSchema.optional(),
  preparedProofSha256: hash, readinessResponseSha256: hash, before: GenericOwnerLossReceiptSchema.shape.before,
}).strict();
const consumedSchema = z.object({ dispatchClaimSha256: hash, actionRequestSha256: hash, actionRequestedAt: time }).strict();
const acceptedSchema = z.object({ responseSha256: hash, httpStatus: z.number().int(), observedAt: time }).strict();
export const GenericWorkerControllerResumeSchema = z.object({ prepared: preparedSchema, consumed: consumedSchema.optional(), accepted: acceptedSchema.optional(), receipt: GenericOwnerLossReceiptSchema.optional() }).strict().refine(value => (!value.accepted || Boolean(value.consumed)) && (!value.receipt || Boolean(value.accepted)));
export type GenericWorkerControllerCheckpoint =
  | { phase: "prepared"; value: z.infer<typeof preparedSchema> }
  | { phase: "consumed"; value: z.infer<typeof consumedSchema> }
  | { phase: "accepted"; value: z.infer<typeof acceptedSchema> }
  | { phase: "receipt"; value: z.infer<typeof GenericOwnerLossReceiptSchema> };

/** Source controller only, not browser/voice test control. The caller must use
 * an immutable on-disk checkpoint writer and independently held key custody.
 * It publishes only owner-loss evidence, never resource cleanup approval. */
export async function executeGenericWorkerTermination(input: {
  runId: string; requestId: string; workerServiceId: string; voiceLabOrigin: string;
  expectedLabSha: string; expectedLangGraphSha: string; renderBearer: string; deploymentBearer: string;
  expectedRecoveryDeployment?: z.infer<typeof RecoveryProductDeploymentSchema>;
  publicConfig: PublicAuthorityConfig; privateKeyPath: string;
  checkpoint: (entry: GenericWorkerControllerCheckpoint) => Promise<void>;
  resume?: unknown; fetchImpl?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; intervalMs?: number; allowHttpForTest?: boolean;
}) {
  z.string().uuid().parse(input.runId); z.string().uuid().parse(input.requestId);
  z.string().regex(/^srv-[0-9a-z]{20}$/).parse(input.workerServiceId);
  if (typeof input.checkpoint !== "function") throw new Error("Durable source checkpoint writer required.");
  const origin = genericRecoveryOrigin(input.voiceLabOrigin, input.allowHttpForTest);
  const fetchImpl = input.fetchImpl ?? fetch, now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeout = z.number().int().min(1000).max(300000).parse(input.timeoutMs ?? 120000);
  const interval = z.number().int().min(100).max(10000).parse(input.intervalMs ?? 1000);
  const resume = input.resume === undefined ? undefined : GenericWorkerControllerResumeSchema.parse(input.resume);
  const request = async (body: Record<string, unknown>) => {
    const response = await fetchImpl(new URL("/internal/voice-lab/recovery/owner-dispatch", origin), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${input.deploymentBearer}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const parsed = await boundedResponse(response);
    if (response.status !== 200) throw new Error(`Generic dispatch endpoint rejected request (HTTP ${response.status}).`);
    const envelope = z.object({ dispatchAllowed: z.boolean(), workerServiceId: z.literal(input.workerServiceId), control: z.object({
      binding: RecoveryControlBindingSchema, version, browserAllocationEver: z.boolean(), browserAllocationBinding: z.unknown().optional(), genericOwnerDispatch: z.unknown().optional(),
      liveCleanupComplete: z.boolean(), remotePurgeComplete: z.boolean(), contentPurgedAt: time.nullable(), retentionPurgeDueAt: time.nullable(),
    }).passthrough() }).strict().parse(parsed.value);
    const raw = envelope.control;
    if (raw.binding.runId !== input.runId) throw new Error("Generic dispatch returned a different run.");
    const control: RecoveryControlRecord = { binding: raw.binding, version: raw.version, browserAllocationEver: raw.browserAllocationEver,
      browserAllocationBinding: validateRecoveryAllocationBinding(raw.binding, raw.browserAllocationBinding),
      ...(raw.genericOwnerDispatch ? { genericOwnerDispatch: parseGenericOwnerDispatch(raw.genericOwnerDispatch) } : {}),
      liveCleanupComplete: raw.liveCleanupComplete, remotePurgeComplete: raw.remotePurgeComplete,
      contentPurgedAt: raw.contentPurgedAt ? new Date(raw.contentPurgedAt) : null, retentionPurgeDueAt: raw.retentionPurgeDueAt ? new Date(raw.retentionPurgeDueAt) : null };
    if (raw.genericOwnerLoss) control.genericOwnerLoss = parseVerifiedGenericOwnerLoss(raw.genericOwnerLoss, control);
    return { control, dispatchAllowed: envelope.dispatchAllowed };
  };
  let { control } = await request({ action: "inspect", runId: input.runId });
  const recoveryDeployment = RecoveryProductDeploymentSchema.parse(input.expectedRecoveryDeployment ?? control.binding.expectedDeployment);
  // The legacy ingestion contract binds the historical product deployment.
  // Refuse an incompatible repair target before consuming a restart permit.
  if (canonicalRequestHash(recoveryDeployment) !== canonicalRequestHash(control.binding.expectedDeployment)) {
    throw new Error("Generic legacy recovery requires the historical deployment; use the service-fence repair contract.");
  }
  if (resume && canonicalRequestHash(resume.prepared.expectedRecoveryDeployment ?? control.binding.expectedDeployment) !== canonicalRequestHash(recoveryDeployment)) {
    throw new Error("Generic source checkpoint recovery deployment mismatch.");
  }
  const publish = async (receipt: GenericOwnerLossReceipt) => {
    const persisted = await request({ action: "ingest_owner_loss", runId: input.runId, expectedVersion: control.version, receipt });
    if (persisted.dispatchAllowed || !persisted.control.genericOwnerLoss) throw new Error("Generic owner receipt persistence is unconfirmed.");
    const proof = verifyGenericOwnerLoss({ control: persisted.control, receipt, authority: input.publicConfig.deployment_control,
      expectedWorkerServiceIdSha256: sha256(input.workerServiceId), expectedLabSha: input.expectedLabSha,
      expectedLangGraphSha: input.expectedLangGraphSha, acceptedAt: new Date(persisted.control.genericOwnerLoss.acceptedAt) });
    if (canonicalRequestHash(proof) !== canonicalRequestHash(persisted.control.genericOwnerLoss)) throw new Error("Generic persisted owner proof differs from the signed receipt.");
    control = persisted.control;
    return proof;
  };
  if (resume?.receipt) {
    if (resume.receipt.receiptId !== input.requestId) throw new Error("Completed source request ID mismatch.");
    verifyGenericOwnerLoss({ control, receipt: resume.receipt, authority: input.publicConfig.deployment_control,
      expectedWorkerServiceIdSha256: sha256(input.workerServiceId), expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha, acceptedAt: new Date(resume.receipt.issuedAt) });
    const proof = await publish(resume.receipt);
    return { status: "owner_loss_verified" as const, receipt: resume.receipt, proof, replacementObserved: true, replay: true };
  }
  const preflightInput = () => ({ control, workerServiceId: input.workerServiceId, voiceLabOrigin: origin, expectedLabSha: input.expectedLabSha,
    expectedRecoveryDeployment: recoveryDeployment,
    expectedLangGraphSha: input.expectedLangGraphSha, renderBearer: input.renderBearer, fetchImpl, now, allowHttpForTest: input.allowHttpForTest === true });
  let prepared = resume?.prepared;
  let accepted = resume?.accepted;
  if (control.genericOwnerDispatch && control.genericOwnerDispatch.requestId !== input.requestId) throw new Error("Generic dispatch request ID differs from its immutable journal.");
  if (prepared && (prepared.requestId !== input.requestId || prepared.controlBindingSha256 !== canonicalRequestHash(control.binding)
    || prepared.allocationBindingSha256 !== canonicalRequestHash(control.browserAllocationBinding) || prepared.workerServiceIdSha256 !== sha256(input.workerServiceId)
    || prepared.expectedLabSha !== input.expectedLabSha || prepared.expectedLangGraphSha !== input.expectedLangGraphSha)) throw new Error("Generic source checkpoint scope mismatch.");
  if (control.genericOwnerDispatch?.consumedAt == null) {
    if (resume?.consumed || accepted) throw new Error("Source checkpoint claims dispatch without a consumed journal.");
    // Fail before consuming the one-shot claim or restarting a worker when
    // this controller cannot produce evidence under the configured authority.
    await validateGenericOwnerSigningCustody(input.publicConfig, input.privateKeyPath);
    const before = await readGenericWorkerPreflight(preflightInput());
    if (!control.genericOwnerDispatch) ({ control } = await request({ action: "prepare", runId: input.runId, expectedVersion: control.version, requestId: input.requestId }));
    prepared = preparedSchema.parse({ requestId: input.requestId, controlBindingSha256: before.controlBindingSha256, allocationBindingSha256: before.allocationBindingSha256,
      workerServiceIdSha256: before.workerServiceIdSha256, expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha,
      expectedRecoveryDeployment: recoveryDeployment,
      readinessResponseSha256: before.readinessResponseSha256, before: before.before, preparedProofSha256: control.genericOwnerDispatch!.proofSha256 });
    await input.checkpoint({ phase: "prepared", value: prepared });
    const consumed = await request({ action: "consume", runId: input.runId, expectedVersion: control.version, preparedProofSha256: prepared.preparedProofSha256 });
    control = consumed.control;
    if (consumed.dispatchAllowed) {
      const dispatch = genericOwnerLossDispatchFromControl(control);
      if (now().getTime() < Date.parse(dispatch.actionRequestedAt) || Date.parse(prepared.before.observedAt) > Date.parse(dispatch.actionRequestedAt)) throw new Error("Controller and dispatch clocks do not establish causal ordering.");
      await input.checkpoint({ phase: "consumed", value: { dispatchClaimSha256: dispatch.dispatchClaimSha256, actionRequestSha256: dispatch.actionRequestSha256, actionRequestedAt: dispatch.actionRequestedAt } });
      // Sole provider POST. Any lost response is observation-only on every resume.
      try {
        const response = await fetchImpl(new URL(`https://api.render.com/v1/services/${input.workerServiceId}/restart`), { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${input.renderBearer}`, accept: "application/json" } });
        const body = await boundedResponse(response, false);
        accepted = { responseSha256: body.sha256, httpStatus: response.status, observedAt: now().toISOString() };
        await input.checkpoint({ phase: "accepted", value: accepted });
      } catch { accepted = undefined; }
    }
  }
  const dispatch = genericOwnerLossDispatchFromControl(control);
  const { proofSha256: _journalProof, ...journalFields } = control.genericOwnerDispatch!;
  if (prepared && prepared.preparedProofSha256 !== canonicalRequestHash({ ...journalFields, consumedAt: null })) throw new Error("Prepared source checkpoint differs from the durable journal.");
  if (resume?.consumed && (resume.consumed.dispatchClaimSha256 !== dispatch.dispatchClaimSha256
    || resume.consumed.actionRequestSha256 !== dispatch.actionRequestSha256 || resume.consumed.actionRequestedAt !== dispatch.actionRequestedAt)) throw new Error("Consumed source checkpoint mismatch.");
  const deadline = now().getTime() + timeout;
  let replacementHash: string | undefined;
  for (let index = 0; index < Math.ceil(timeout / interval) && now().getTime() <= deadline; index++) {
    const observed = await readRenderWorkerSnapshot({ render_api_origin: "https://api.render.com", render_worker_service_id: input.workerServiceId }, input.renderBearer, fetchImpl, new Date(dispatch.actionRequestedAt)).catch(retryableRenderObservation);
    if (observed && observed.instanceIds.length === 1 && observed.deployStatus === "live" && observed.deploySettledAt !== null
      && sha256(observed.instanceIds[0]!) !== control.browserAllocationBinding!.browser_worker_id_sha256
      && observed.instanceCreatedAt[0]!.getTime() >= Date.parse(dispatch.actionRequestedAt)) { replacementHash = sha256(observed.instanceIds[0]!); break; }
    await sleep(interval);
  }
  if (!replacementHash || !prepared || !accepted || accepted.httpStatus !== 200) return { status: "unconfirmed" as const, dispatchClaimSha256: dispatch.dispatchClaimSha256, replacementObserved: Boolean(replacementHash), receipt: null };
  const after = await readGenericWorkerReplacementPreflight(preflightInput(), replacementHash);
  const authority = input.publicConfig.deployment_control;
  const issuedAt = now();
  const receipt = await signGenericOwnerLossReceipt({ schema: "sophia.voice-lab.generic-owner-loss-receipt.v1", receiptId: input.requestId,
    authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id, audience: "sophia-voice-lab-generic-owner-loss",
    expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha,
    ...dispatch, workerIdSha256: control.browserAllocationBinding!.browser_worker_id_sha256, browserLeaseEpoch: control.browserAllocationBinding!.browser_lease_epoch,
    actionAcceptedResponseSha256: accepted.responseSha256, actionHttpStatus: 200, actionAcceptedAt: accepted.observedAt,
    before: prepared.before, after: after.before, providerCleanupProven: false, liveResourcesZeroProven: false,
    issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + 300000).toISOString(), signatureAlgorithm: "ed25519-sha256-canonical-request-v1",
  }, input.publicConfig, input.privateKeyPath);
  verifyGenericOwnerLoss({ control, receipt, authority, expectedWorkerServiceIdSha256: sha256(input.workerServiceId), expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha, acceptedAt: now() });
  await input.checkpoint({ phase: "receipt", value: receipt });
  const proof = await publish(receipt);
  return { status: "owner_loss_verified" as const, receipt, proof, replacementObserved: true };
}

async function boundedResponse(response: Response, parseJson = true) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 262144) throw new Error("Generic controller response exceeds byte bound.");
  return { sha256: sha256(bytes), value: parseJson ? JSON.parse(bytes.toString("utf8")) as unknown : null };
}
