import { z } from "zod";
import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { RecoveryControlBindingSchema, validateRecoveryAllocationBinding, type RecoveryControlRecord } from "../../src/recovery-control.js";
import { parseGenericOwnerDispatch, genericOwnerLossDispatchFromControl } from "../../src/generic-owner-dispatch.js";
import { parseExecutionOwnership } from "../../src/execution-ownership.js";
import { AnyServiceOwnerFenceReceiptSchema, ServiceOwnerFenceReceiptSchema, SERVICE_FENCE_V1_VALIDITY_MS, SERVICE_FENCE_V2_VALIDITY_MS, verifyServiceOwnerFence, type OriginalOwnerPreAction } from "../../src/service-owner-fence.js";
import { genericRecoveryOrigin, readServiceOwnerFencePreflight, readServiceOwnerFenceV2AbsentPreflight, readServiceOwnerFenceV2Preflight, RecoveryProductDeploymentSchema } from "./generic-worker-preflight.js";
import { renderInventoryInstanceId } from "../../src/worker-identity.js";
import { readRenderWorkerSnapshot } from "./render-worker-controller.js";
import { retryableRenderObservation } from "./render-inventory.js";
import { validateGenericOwnerSigningCustody, signServiceOwnerFenceReceipt } from "./crypto.js";
import type { PublicAuthorityConfig } from "./contracts.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime();
const prepared = z.object({ scopeSha256: hash, preparedProofSha256: hash, before: ServiceOwnerFenceReceiptSchema.shape.before }).strict();
const consumed = z.object({ dispatchClaimSha256: hash, actionRequestSha256: hash, actionRequestedAt: time }).strict();
const accepted = z.object({ responseSha256: hash, httpStatus: z.number().int(), observedAt: time }).strict();
export const ServiceOwnerFenceResumeSchema = z.object({
  prepared, consumed: consumed.optional(), accepted: accepted.optional(), receipt: AnyServiceOwnerFenceReceiptSchema.optional(),
}).strict().refine(value => (!value.accepted || Boolean(value.consumed)) && (!value.receipt || Boolean(value.accepted)));
export type ServiceOwnerFenceCheckpoint =
  | { phase: "prepared"; value: z.infer<typeof prepared> }
  | { phase: "consumed"; value: z.infer<typeof consumed> }
  | { phase: "accepted"; value: z.infer<typeof accepted> }
  | { phase: "receipt"; value: z.infer<typeof AnyServiceOwnerFenceReceiptSchema> };

/** Independent platform collector, never a browser/voice runtime. The offline
 * caller must authenticate resume bytes and exclusively append each checkpoint
 * before this controller advances. There is no operator-JSON signing lane.
 * Receipt collection alone is deliberately NOT durable recovery ingestion. */
export async function collectServiceOwnerFence(input: {
  runId: string; requestId: string; workerServiceId: string; allocatedWorkerId: string; voiceLabOrigin: string;
  generation?: "v1" | "v2" | undefined;
  // v2 only. Omitted means "present" (the original v2 contract). "absent" must
  // be requested explicitly; the collector never switches modes on its own.
  originalOwnerPreAction?: OriginalOwnerPreAction | undefined;
  expectedLabSha: string; expectedLangGraphSha: string; expectedRecoveryDeployment: z.infer<typeof RecoveryProductDeploymentSchema>;
  renderBearer: string; deploymentBearer: string; publicConfig: PublicAuthorityConfig; privateKeyPath: string;
  checkpoint: (entry: ServiceOwnerFenceCheckpoint) => Promise<void>; resume?: unknown;
  fetchImpl?: typeof fetch; now?: () => Date; sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; intervalMs?: number; allowHttpForTest?: boolean;
}) {
  z.string().uuid().parse(input.runId); z.string().uuid().parse(input.requestId);
  z.string().regex(/^srv-[0-9a-z]{20}$/).parse(input.workerServiceId);
  RecoveryProductDeploymentSchema.parse(input.expectedRecoveryDeployment);
  if (typeof input.checkpoint !== "function") throw new Error("Service fence requires a durable checkpoint writer.");
  const origin = genericRecoveryOrigin(input.voiceLabOrigin, input.allowHttpForTest);
  const fetchImpl = input.fetchImpl ?? fetch, now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const interval = z.number().int().min(100).max(10000).parse(input.intervalMs ?? 1000);
  const timeout = z.number().int().min(1000).max(900000).parse(input.timeoutMs ?? 600000);
  const resume = input.resume === undefined ? undefined : ServiceOwnerFenceResumeSchema.parse(input.resume);
  // v1 collects after the allocated owner is already gone. v2 collects while it
  // is still present, so the prospective replacement is what removes it. The
  // caller selects explicitly; v1 remains the default and is unchanged.
  const { generation, preAction } = serviceFenceMode(input);
  const readFencePreflight = serviceFencePreflight(generation, preAction);
  // Render's inventory omits the replica-set segment, so the identity a
  // replacement must differ from is the ORIGINAL's projection, not its full id.
  const originalInventoryId = renderInventoryInstanceId(input.allocatedWorkerId);
  if (generation === "v2" && originalInventoryId === null) throw new Error("Service fence v2 original owner has no supported Render inventory projection.");
  const originalComparisonSha256 = generation === "v2" ? sha256(originalInventoryId!) : sha256(input.allocatedWorkerId);
  const request = async (body: Record<string, unknown>) => {
    const response = await fetchImpl(new URL("/internal/voice-lab/recovery/owner-dispatch", origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${input.deploymentBearer}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
    });
    const result = await readBody(response);
    if (response.status !== 200) throw new Error(`Service fence dispatch HTTP ${response.status}.`);
    const envelope = z.object({ dispatchAllowed: z.boolean(), workerServiceId: z.literal(input.workerServiceId), control: z.object({
      binding: RecoveryControlBindingSchema, version: z.number().int().positive(), browserAllocationEver: z.literal(true),
      browserAllocationBinding: z.unknown(), genericOwnerDispatch: z.unknown().optional(),
      // Explicitly carried, not assumed to survive projection: the v2 fence
      // binds the exact execution ownership the original pod held.
      executionOwnership: z.unknown().optional(),
      liveCleanupComplete: z.literal(false), remotePurgeComplete: z.boolean(), contentPurgedAt: time.nullable(), retentionPurgeDueAt: time.nullable(),
    }).passthrough() }).strict().parse(JSON.parse(result.bytes.toString("utf8")));
    const raw = envelope.control;
    if (raw.binding.runId !== input.runId || raw.binding.scenarioId === "V-D02") throw new Error("Service fence scope mismatch.");
    const control: RecoveryControlRecord = { binding: raw.binding, version: raw.version, browserAllocationEver: true,
      browserAllocationBinding: validateRecoveryAllocationBinding(raw.binding, raw.browserAllocationBinding),
      ...(raw.genericOwnerDispatch ? { genericOwnerDispatch: parseGenericOwnerDispatch(raw.genericOwnerDispatch) } : {}),
      ...(raw.executionOwnership === undefined || raw.executionOwnership === null
        ? {} : { executionOwnership: parseExecutionOwnership(raw.executionOwnership) }),
      liveCleanupComplete: false, remotePurgeComplete: raw.remotePurgeComplete,
      contentPurgedAt: raw.contentPurgedAt ? new Date(raw.contentPurgedAt) : null, retentionPurgeDueAt: raw.retentionPurgeDueAt ? new Date(raw.retentionPurgeDueAt) : null };
    return { control, dispatchAllowed: envelope.dispatchAllowed };
  };
  let { control } = await request({ action: "inspect", runId: input.runId });
  // A v2 collection binds the retained execution ownership. Establish it BEFORE
  // preparing or consuming the dispatch, so a control without ownership can
  // never reach the single provider mutation and fail afterwards.
  const ownership = generation === "v2" ? parseExecutionOwnership(control.executionOwnership) : null;
  if (ownership) {
    // A correctly self-digested ownership proof for a DIFFERENT run, owner or
    // lease must be refused here, before the one-shot mutation. The receipt
    // verifier re-checks this, but that happens after the restart.
    const allocation = validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding);
    if (ownership.runIdSha256 !== sha256(input.runId)
      || ownership.runIdSha256 !== sha256(control.binding.runId)
      || ownership.cleanupObligationIdSha256 !== sha256(control.binding.cleanupObligationId)
      || ownership.workerIdSha256 !== allocation.browser_worker_id_sha256
      || ownership.workerIdSha256 !== sha256(input.allocatedWorkerId)
      || ownership.browserLeaseEpoch !== allocation.browser_lease_epoch) throw new Error("Service fence v2 execution ownership does not bind this run allocation.");
  }
  const scopeSha256 = canonicalRequestHash({ runId: input.runId, requestId: input.requestId, workerServiceId: input.workerServiceId,
    allocatedWorkerIdSha256: sha256(input.allocatedWorkerId), controlBindingSha256: canonicalRequestHash(control.binding),
    allocationBindingSha256: canonicalRequestHash(control.browserAllocationBinding), expectedLabSha: input.expectedLabSha,
    expectedLangGraphSha: input.expectedLangGraphSha, expectedRecoveryDeployment: input.expectedRecoveryDeployment, authority: input.publicConfig.deployment_control,
    // Scope compatibility: these fields exist only for v2, so a historical v1
    // journal keeps its exact resume hash and stays resumable.
    ...(ownership ? { generation, executionOwnershipProofSha256: ownership.proofSha256, ...absentPreActionClaim(preAction) } : {}) });
  if (resume && resume.prepared.scopeSha256 !== scopeSha256) throw new Error("Service fence resume scope mismatch.");
  if (control.genericOwnerDispatch && control.genericOwnerDispatch.requestId !== input.requestId) throw new Error("Service fence dispatch request mismatch.");
  const verification = () => ({ control, authority: input.publicConfig.deployment_control, expectedWorkerServiceIdSha256: sha256(input.workerServiceId),
    expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha, expectedRecoveryDeployment: input.expectedRecoveryDeployment });
  if (resume?.receipt) {
    const proof = verifyServiceOwnerFence({ ...verification(), receipt: resume.receipt, acceptedAt: new Date(resume.receipt.issuedAt) });
    return { status: "receipt_collected" as const, receipt: resume.receipt, proof, replay: true };
  }
  const preflightInput = () => ({ control, workerServiceId: input.workerServiceId, allocatedWorkerId: input.allocatedWorkerId,
    voiceLabOrigin: origin, expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha,
    expectedRecoveryDeployment: input.expectedRecoveryDeployment, renderBearer: input.renderBearer, fetchImpl, now, allowHttpForTest: input.allowHttpForTest === true });
  let before = resume?.prepared;
  let action = resume?.accepted;
  if (control.genericOwnerDispatch?.consumedAt == null) {
    if (resume?.consumed || action) throw new Error("Service fence checkpoint claims an unrecorded dispatch.");
    await validateGenericOwnerSigningCustody(input.publicConfig, input.privateKeyPath);
    const observed = await readFencePreflight(preflightInput());
    // The preflight trusts the heartbeat's own projection; the v2 receipt is
    // checked against the locally derived projection of the allocated id. Join
    // them here, because a mismatch found at signing is after the restart.
    if (generation === "v2") assertPreActionOwnerState(preAction, observed.before.instanceIdsSha256, originalComparisonSha256);
    if (!control.genericOwnerDispatch) ({ control } = await request({ action: "prepare", runId: input.runId, requestId: input.requestId, expectedVersion: control.version }));
    before = { scopeSha256, preparedProofSha256: control.genericOwnerDispatch!.proofSha256,
      before: { ...observed.before, readinessResponseSha256: observed.readinessResponseSha256 } };
    await input.checkpoint({ phase: "prepared", value: before });
    const permit = await request({ action: "consume", runId: input.runId, expectedVersion: control.version, preparedProofSha256: before.preparedProofSha256 });
    control = permit.control;
    if (permit.dispatchAllowed) {
      const dispatch = genericOwnerLossDispatchFromControl(control);
      if (Date.parse(before.before.observedAt) > Date.parse(dispatch.actionRequestedAt)
        || now().getTime() - Date.parse(before.before.observedAt) > 15000) throw new Error("Service fence preflight expired before dispatch.");
      await input.checkpoint({ phase: "consumed", value: { dispatchClaimSha256: dispatch.dispatchClaimSha256, actionRequestSha256: dispatch.actionRequestSha256, actionRequestedAt: dispatch.actionRequestedAt } });
      // The only provider mutation. Any ambiguous outcome is observation-only.
      try {
        const response = await fetchImpl(new URL(`https://api.render.com/v1/services/${input.workerServiceId}/restart`), {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${input.renderBearer}`, accept: "application/json" },
        });
        const result = await readBody(response);
        action = { responseSha256: result.sha256, httpStatus: response.status, observedAt: now().toISOString() };
        await input.checkpoint({ phase: "accepted", value: action });
      } catch { action = undefined; }
    }
  }
  const dispatch = genericOwnerLossDispatchFromControl(control);
  const { proofSha256: _digest, ...journal } = control.genericOwnerDispatch!;
  if (before && before.preparedProofSha256 !== canonicalRequestHash({ ...journal, consumedAt: null })) throw new Error("Service fence prepared checkpoint differs from ledger.");
  if (resume?.consumed && canonicalRequestHash(resume.consumed) !== canonicalRequestHash({ dispatchClaimSha256: dispatch.dispatchClaimSha256, actionRequestSha256: dispatch.actionRequestSha256, actionRequestedAt: dispatch.actionRequestedAt })) throw new Error("Service fence consumed checkpoint differs from ledger.");
  if (!before || !action || action.httpStatus !== 200) return { status: "unconfirmed" as const, receipt: null, proof: null, replay: false };
  const deadline = now().getTime() + timeout;
  for (let count = 0; count < Math.ceil(timeout / interval) && now().getTime() <= deadline; count++) {
    if (now().getTime() - Date.parse(action.observedAt) < 360000) { await sleep(interval); continue; }
    const observed = await readRenderWorkerSnapshot({ render_api_origin: "https://api.render.com", render_worker_service_id: input.workerServiceId }, input.renderBearer, fetchImpl, new Date(dispatch.actionRequestedAt)).catch(retryableRenderObservation);
    if (!observed || observed.instanceIds.length !== 1 || observed.deploySettledAt === null
      || sha256(observed.instanceIds[0]!) === before.before.instanceIdsSha256[0]
      || sha256(observed.instanceIds[0]!) === originalComparisonSha256
      || observed.instanceCreatedAt[0]!.getTime() < Date.parse(dispatch.actionRequestedAt)) { await sleep(interval); continue; }
    // After the action the original owner must be GONE for both generations,
    // so the post-action observation always uses the retired-owner contract.
    const after = await readServiceOwnerFencePreflight(preflightInput());
    if (after.before.instanceIdsSha256[0] !== sha256(observed.instanceIds[0]!)) throw new Error("Service fence replacement changed during final preflight.");
    const authority = input.publicConfig.deployment_control;
    const issuedAt = now();
    const receipt = await signServiceOwnerFenceReceipt({ ...(ownership ? {
      executionOwnershipProofSha256: ownership.proofSha256, executionEpochSha256: ownership.executionEpochSha256,
      processIdSha256: ownership.processIdSha256, browserBootIdSha256: ownership.browserBootIdSha256,
      processAcquiredSeq: ownership.processAcquiredSeq, runtimeAcquiredSeq: ownership.runtimeAcquiredSeq,
      ...absentPreActionClaim(preAction),
    } : {}), schema: generation === "v2" ? "sophia.voice-lab.service-owner-fence-receipt.v2" : "sophia.voice-lab.service-owner-fence-receipt.v1", receiptId: input.requestId,
      authority: "deployment_control", issuer: authority.issuer, subject: authority.subject, authorityKeyId: authority.key_id,
      audience: "sophia-voice-lab-service-owner-fence", ...dispatch, allocatedWorkerId: input.allocatedWorkerId,
      workerIdSha256: sha256(input.allocatedWorkerId), browserLeaseEpoch: control.browserAllocationBinding!.browser_lease_epoch,
      expectedLabSha: input.expectedLabSha, expectedLangGraphSha: input.expectedLangGraphSha, expectedRecoveryDeployment: input.expectedRecoveryDeployment,
      actionAcceptedResponseSha256: action.responseSha256, actionHttpStatus: 200, actionAcceptedAt: action.observedAt,
      before: before.before, after: { ...after.before, readinessResponseSha256: after.readinessResponseSha256 },
      providerCleanupProven: false, liveResourcesZeroProven: false, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + (generation === "v2" ? SERVICE_FENCE_V2_VALIDITY_MS : SERVICE_FENCE_V1_VALIDITY_MS)).toISOString(),
      signatureAlgorithm: "ed25519-sha256-canonical-request-v1" }, input.publicConfig, input.privateKeyPath);
    const proof = verifyServiceOwnerFence({ ...verification(), receipt, acceptedAt: now() });
    await input.checkpoint({ phase: "receipt", value: receipt });
    return { status: "receipt_collected" as const, receipt, proof, replay: false };
  }
  return { status: "unconfirmed" as const, receipt: null, proof: null, replay: false };
}

async function readBody(response: Response) {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2_000_000) throw new Error("Service fence response exceeds source byte limit.");
  return { bytes, sha256: sha256(bytes) };
}

/** The collection mode, stated by the caller and never inferred. v1 stays the
 * default; "absent" exists only for v2 and only when named. */
function serviceFenceMode(input: { generation?: "v1" | "v2" | undefined; originalOwnerPreAction?: OriginalOwnerPreAction | undefined }): { generation: "v1" | "v2"; preAction: OriginalOwnerPreAction } {
  const generation = input.generation ?? "v1";
  const preAction = z.enum(["present", "absent"]).parse(input.originalOwnerPreAction ?? "present");
  if (preAction === "absent" && generation !== "v2") throw new Error("Service fence original-owner-absent mode exists only for v2.");
  return { generation, preAction };
}

function serviceFencePreflight(generation: "v1" | "v2", preAction: OriginalOwnerPreAction) {
  if (generation === "v1") return readServiceOwnerFencePreflight;
  return preAction === "absent" ? readServiceOwnerFenceV2AbsentPreflight : readServiceOwnerFenceV2Preflight;
}

/** Before the one-shot action, the live singleton must be exactly the original
 * projection in present mode, and anything but it in absent mode. */
function assertPreActionOwnerState(preAction: OriginalOwnerPreAction, instanceIdsSha256: string[], originalInventorySha256: string): void {
  if (instanceIdsSha256.length !== 1) throw new Error("Service fence v2 live inventory is not a singleton.");
  const originalPresent = instanceIdsSha256[0] === originalInventorySha256;
  if (preAction === "present" && !originalPresent) throw new Error("Service fence v2 live inventory is not the original owner's inventory projection.");
  if (preAction === "absent" && originalPresent) throw new Error("Service fence v2 absent mode found the original owner still present.");
}

/** The signed and journal-scoped claim; empty in present mode so its bytes and
 * hashes are exactly those of the original v2 contract. */
function absentPreActionClaim(preAction: OriginalOwnerPreAction): { originalOwnerPreAction?: "absent" } {
  return preAction === "absent" ? { originalOwnerPreAction: "absent" } : {};
}
