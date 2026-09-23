import { z } from "zod";
import { canonicalRequestHash, sha256 } from "../../src/security.js";
import { RecoveryControlBindingSchema, validateRecoveryAllocationBinding, type RecoveryControlRecord } from "../../src/recovery-control.js";
import { parseGenericOwnerDispatch } from "../../src/generic-owner-dispatch.js";
import { parseExecutionOwnership } from "../../src/execution-ownership.js";
import { AnyServiceOwnerFenceReceiptSchema, parseVerifiedServiceOwnerFence, verifyServiceOwnerFence } from "../../src/service-owner-fence.js";
import { genericRecoveryOrigin, RecoveryProductDeploymentSchema } from "./generic-worker-preflight.js";
import type { PublicAuthorityConfig } from "./contracts.js";

/** Publication only. No Render credential, signing key, prepare, consume or
 * restart path is available here. An ambiguous POST is followed by one read;
 * a later invocation reuses the same immutable source receipt. */
export async function publishServiceOwnerFence(input: {
  runId: string; workerServiceId: string; voiceLabOrigin: string; receipt: unknown;
  expectedLabSha: string; expectedLangGraphSha: string; expectedRecoveryDeployment: z.infer<typeof RecoveryProductDeploymentSchema>;
  publicConfig: Pick<PublicAuthorityConfig, "deployment_control">; deploymentBearer: string;
  fetchImpl?: typeof fetch; now?: () => Date; allowHttpForTest?: boolean;
}) {
  z.string().uuid().parse(input.runId);
  z.string().regex(/^srv-[0-9a-z]{20}$/).parse(input.workerServiceId);
  const receipt = AnyServiceOwnerFenceReceiptSchema.parse(input.receipt);
  const origin = genericRecoveryOrigin(input.voiceLabOrigin, input.allowHttpForTest);
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  const request = async (body: unknown): Promise<RecoveryControlRecord> => {
    const response = await fetchImpl(new URL("/internal/voice-lab/recovery/owner-dispatch", origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${input.deploymentBearer}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(`Service fence publication HTTP ${response.status}.`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 2_000_000) throw new Error("Service fence publication response too large.");
    const result = z.object({ dispatchAllowed: z.literal(false), workerServiceId: z.literal(input.workerServiceId), control: z.object({
      binding: RecoveryControlBindingSchema, version: z.number().int().positive(), browserAllocationEver: z.literal(true),
      browserAllocationBinding: z.unknown(), genericOwnerDispatch: z.unknown(), genericOwnerLoss: z.unknown().optional(),
      // A v2 proof binds the retained execution ownership; without it neither
      // the receipt nor a stored v2 proof can be verified against this control.
      executionOwnership: z.unknown().optional(),
      liveCleanupComplete: z.boolean(), remotePurgeComplete: z.boolean(),
      contentPurgedAt: z.string().datetime().nullable(), retentionPurgeDueAt: z.string().datetime().nullable(),
    }).passthrough() }).strict().parse(JSON.parse(bytes.toString("utf8")));
    const raw = result.control;
    if (raw.binding.runId !== input.runId) throw new Error("Service fence publication control mismatch.");
    return { binding: raw.binding, version: raw.version, browserAllocationEver: true,
      browserAllocationBinding: validateRecoveryAllocationBinding(raw.binding, raw.browserAllocationBinding),
      genericOwnerDispatch: parseGenericOwnerDispatch(raw.genericOwnerDispatch),
      ...(raw.executionOwnership === undefined || raw.executionOwnership === null
        ? {} : { executionOwnership: parseExecutionOwnership(raw.executionOwnership) }),
      ...(raw.genericOwnerLoss ? { genericOwnerLoss: parseVerifiedServiceOwnerFence(raw.genericOwnerLoss) } : {}),
      liveCleanupComplete: raw.liveCleanupComplete, remotePurgeComplete: raw.remotePurgeComplete,
      contentPurgedAt: raw.contentPurgedAt ? new Date(raw.contentPurgedAt) : null,
      retentionPurgeDueAt: raw.retentionPurgeDueAt ? new Date(raw.retentionPurgeDueAt) : null };
  };
  const verified = (control: RecoveryControlRecord) => {
    const stored = control.genericOwnerLoss ? parseVerifiedServiceOwnerFence(control.genericOwnerLoss, control) : null;
    const proof = verifyServiceOwnerFence({ control, receipt, authority: input.publicConfig.deployment_control,
      expectedWorkerServiceIdSha256: sha256(input.workerServiceId), expectedLabSha: input.expectedLabSha,
      expectedLangGraphSha: input.expectedLangGraphSha, expectedRecoveryDeployment: input.expectedRecoveryDeployment,
      acceptedAt: stored ? new Date(stored.acceptedAt) : now() });
    if (stored && canonicalRequestHash(stored) !== canonicalRequestHash(proof)) throw new Error("Service fence persisted proof mismatch.");
    return stored;
  };
  // For v2 the receiver persists the proof and THEN appends the canonical
  // platform-termination event, the only one the cleanup evaluator accepts in
  // place of a browser close. A visible proof therefore does not show that the
  // event exists; only an ingestion replay, immutable for the proof and
  // deduplicated for the event, can write it.
  const v2 = receipt.schema === "sophia.voice-lab.service-owner-fence-receipt.v2";
  const initial = await request({ action: "inspect", runId: input.runId });
  const existing = verified(initial);
  if (existing) {
    // Independent recovery can settle the control without this event, so
    // liveCleanupComplete is not evidence it exists. The receiver admits a
    // replay into settled control (only FIRST admission is refused there).
    if (v2) {
      const replayed = verified(await request({ action: "ingest_service_fence", runId: input.runId, expectedVersion: initial.version, receipt }));
      if (!replayed || replayed.proofSha256 !== existing.proofSha256) throw new Error("Service fence replay changed the persisted proof.");
    }
    return { status: "ingested" as const, proofSha256: existing.proofSha256, replay: true, cleanupProven: false as const };
  }
  if (initial.liveCleanupComplete) throw new Error("Service fence first publication cannot target settled control.");
  try {
    const current = await request({ action: "ingest_service_fence", runId: input.runId, expectedVersion: initial.version, receipt });
    const proof = verified(current);
    if (proof) return { status: "ingested" as const, proofSha256: proof.proofSha256, replay: false, cleanupProven: false as const };
  } catch {
    // A response failure is not rollback proof. Do not retry a mutation here.
  }
  try {
    const proof = verified(await request({ action: "inspect", runId: input.runId }));
    // A v2 proof seen after a failed response may lack its termination event;
    // report it unconfirmed so the next invocation replays ingestion.
    if (proof && !v2) return { status: "ingested" as const, proofSha256: proof.proofSha256, replay: true, cleanupProven: false as const };
  } catch { /* Leave publication unconfirmed, never infer resource closure. */ }
  return { status: "unconfirmed" as const, proofSha256: null, replay: false, cleanupProven: false as const };
}
