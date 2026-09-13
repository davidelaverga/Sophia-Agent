import { z } from "zod";
import { canonicalRequestHash, sha256 } from "./security.js";
import { validateRecoveryAllocationBinding, type RecoveryControlRecord } from "./recovery-control.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const core = z.object({
  schema: z.literal("sophia.voice-lab.generic-owner-dispatch.v1"),
  requestId: z.string().uuid(), preparedFromVersion: version,
  controlBindingSha256: hash, allocationBindingSha256: hash,
  workerServiceIdSha256: hash, workerIdSha256: hash,
  actionRequestSha256: hash, preparedAt: time,
  consumedAt: time.nullable(),
}).strict().refine(value => value.consumedAt === null || Date.parse(value.consumedAt) >= Date.parse(value.preparedAt));
export type GenericOwnerDispatchJournal = z.infer<typeof core> & { proofSha256: string };
export interface PrepareGenericOwnerDispatch { runId: string; expectedVersion: number; requestId: string; workerServiceId: string; }
export interface ConsumeGenericOwnerDispatch { runId: string; expectedVersion: number; preparedProofSha256: string; }
export interface GenericOwnerDispatchResult { dispatchAllowed: boolean; control: RecoveryControlRecord; }

export function parseGenericOwnerDispatch(input: unknown): GenericOwnerDispatchJournal {
  const { proofSha256, ...fields } = z.object({ proofSha256: hash }).passthrough().parse(input);
  const parsed = core.parse(fields);
  if (canonicalRequestHash(parsed) !== proofSha256) throw new Error("GENERIC_DISPATCH_DIGEST_INVALID");
  return { ...parsed, proofSha256 };
}
function seal(fields: z.infer<typeof core>): GenericOwnerDispatchJournal {
  const parsed = core.parse(fields);
  return { ...parsed, proofSha256: canonicalRequestHash(parsed) };
}
export function prepareGenericOwnerDispatch(control: RecoveryControlRecord, input: PrepareGenericOwnerDispatch, now: Date): GenericOwnerDispatchJournal {
  z.string().uuid().parse(input.requestId);
  z.string().regex(/^srv-[0-9a-z]{20}$/).parse(input.workerServiceId);
  version.parse(input.expectedVersion);
  if (control.binding.runId !== input.runId || control.binding.scenarioId === "V-D02" || !control.browserAllocationEver || control.liveCleanupComplete) throw new Error("GENERIC_DISPATCH_SCOPE_INVALID");
  const allocation = validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding);
  const proposed = seal({ schema: "sophia.voice-lab.generic-owner-dispatch.v1", requestId: input.requestId,
    preparedFromVersion: input.expectedVersion,
    controlBindingSha256: canonicalRequestHash(control.binding), allocationBindingSha256: canonicalRequestHash(allocation),
    workerServiceIdSha256: sha256(input.workerServiceId), workerIdSha256: allocation.browser_worker_id_sha256,
    actionRequestSha256: canonicalRequestHash({ method: "POST", provider: "render", action: "restart",
      path_sha256: sha256(`/v1/services/${input.workerServiceId}/restart`), body_sha256: sha256(Buffer.alloc(0)), termination_request_id_sha256: sha256(input.requestId) }),
    preparedAt: control.genericOwnerDispatch?.preparedAt ?? now.toISOString(), consumedAt: null });
  if (control.genericOwnerDispatch) {
    const existing = parseGenericOwnerDispatch(control.genericOwnerDispatch);
    const { proofSha256: _proof, ...fields } = existing;
    const original = seal({ ...fields, consumedAt: null });
    if (original.proofSha256 !== proposed.proofSha256) throw new Error("GENERIC_DISPATCH_IMMUTABLE_CONFLICT");
    return existing;
  }
  if (control.version !== input.expectedVersion) throw new Error("GENERIC_DISPATCH_VERSION_CONFLICT");
  return proposed;
}
export function consumeGenericOwnerDispatch(control: RecoveryControlRecord, input: ConsumeGenericOwnerDispatch, now: Date): GenericOwnerDispatchJournal {
  const journal = parseGenericOwnerDispatch(control.genericOwnerDispatch);
  const { proofSha256: _proof, ...fields } = journal;
  const prepared = seal({ ...fields, consumedAt: null });
  if (input.runId !== control.binding.runId || input.preparedProofSha256 !== prepared.proofSha256
    || control.binding.scenarioId === "V-D02" || control.liveCleanupComplete
    || canonicalRequestHash(control.binding) !== journal.controlBindingSha256
    || canonicalRequestHash(validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding)) !== journal.allocationBindingSha256) throw new Error("GENERIC_DISPATCH_BINDING_MISMATCH");
  if (journal.consumedAt !== null) return journal; // Observation only, never another permit.
  if (control.version !== input.expectedVersion) throw new Error("GENERIC_DISPATCH_VERSION_CONFLICT");
  if (now.getTime() < Date.parse(journal.preparedAt) || now.getTime() - Date.parse(journal.preparedAt) > 300_000) throw new Error("GENERIC_DISPATCH_EXPIRED");
  return seal({ ...fields, consumedAt: now.toISOString() });
}

/** Receipt verification uses the stored consumed claim, never caller assertions. */
export function genericOwnerLossDispatchFromControl(control: RecoveryControlRecord) {
  const journal = parseGenericOwnerDispatch(control.genericOwnerDispatch);
  if (journal.consumedAt === null || journal.controlBindingSha256 !== canonicalRequestHash(control.binding)
    || journal.allocationBindingSha256 !== canonicalRequestHash(validateRecoveryAllocationBinding(control.binding, control.browserAllocationBinding))) throw new Error("GENERIC_DISPATCH_NOT_CONSUMED");
  return { controlBindingSha256: journal.controlBindingSha256, allocationBindingSha256: journal.allocationBindingSha256,
    workerServiceIdSha256: journal.workerServiceIdSha256, dispatchClaimSha256: journal.proofSha256,
    actionRequestSha256: journal.actionRequestSha256, actionRequestedAt: journal.consumedAt };
}
